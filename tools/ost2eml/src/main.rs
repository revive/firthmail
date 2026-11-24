//! ost2eml: export the mail from an Outlook OST/PST data file as EML or mbox,
//! for import into another mail client (Flectar Mail reads both).

mod cache;
mod eml;
mod props;
mod walk;

use std::env;
use std::fs;
use std::io::{self, BufWriter, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use outlook_pst::messaging::folder::Folder;

const USAGE: &str = "\
ost2eml - export mail from an Outlook OST/PST data file

usage: ost2eml <ost-or-pst> <output-dir> [options]

options:
  --list           list folders and counts only, export nothing
  --mbox           one .mbox file per folder instead of an .eml tree
  --all-classes    export every item class, not just IPM.Note mail
  --limit N        export at most N messages (for a quick test)
  --only PAT       export only folders whose path contains PAT (repeatable)
  --cache MIB      block cache size in MiB (default 32)";

struct Args {
    input: PathBuf,
    out: PathBuf,
    list: bool,
    mbox: bool,
    all_classes: bool,
    limit: Option<u64>,
    only: Vec<String>,
    cache_mib: usize,
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

fn parse_args() -> Result<Args, String> {
    let raw: Vec<String> = env::args().skip(1).collect();
    let mut positional: Vec<String> = Vec::new();
    let mut args = Args {
        input: PathBuf::new(),
        out: PathBuf::new(),
        list: false,
        mbox: false,
        all_classes: false,
        limit: None,
        only: Vec::new(),
        cache_mib: 32,
    };
    let mut i = 0;
    while i < raw.len() {
        match raw[i].as_str() {
            "--list" => args.list = true,
            "--mbox" => args.mbox = true,
            "--all-classes" => args.all_classes = true,
            "--limit" => {
                i += 1;
                let value = raw.get(i).ok_or("--limit needs a number")?;
                args.limit = Some(value.parse().map_err(|_| "--limit needs a number".to_string())?);
            }
            "--only" => {
                i += 1;
                let value = raw.get(i).ok_or("--only needs a pattern")?;
                args.only.push(value.clone());
            }
            "--cache" => {
                i += 1;
                let value = raw.get(i).ok_or("--cache needs a number")?;
                args.cache_mib =
                    value.parse().map_err(|_| "--cache needs a number".to_string())?;
            }
            other if other.starts_with("--") => return Err(format!("unknown option {other}")),
            other => positional.push(other.to_string()),
        }
        i += 1;
    }
    if positional.len() != 2 {
        return Err("expected exactly two arguments: <ost-or-pst> <output-dir>".into());
    }
    args.input = PathBuf::from(&positional[0]);
    args.out = PathBuf::from(&positional[1]);
    Ok(args)
}

fn run(args: &Args) -> Result<(), String> {
    let mail = walk::open(&args.input, args.cache_mib)
        .map_err(|err| format!("{}: {err}", args.input.display()))?;
    eprintln!("store: {}", mail.display_name());
    let store = mail.store();
    let folders = walk::collect(store).map_err(|err| format!("folder walk: {err}"))?;
    eprintln!("folders: {}", folders.len());

    if args.list {
        for folder in &folders {
            let items = folder.folder.properties().content_count().unwrap_or(-1);
            let unread = folder.folder.properties().unread_count().unwrap_or(-1);
            let name = if folder.path.is_empty() {
                "(top)".to_string()
            } else {
                folder.path.join("/")
            };
            println!("{name}: {items} items, {unread} unread");
        }
        return Ok(());
    }

    fs::create_dir_all(&args.out).map_err(|err| format!("{}: {err}", args.out.display()))?;

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    let mut error_notes: u64 = 0;

    'folders: for folder in &folders {
        let folder_name = if folder.path.is_empty() {
            "(top)".to_string()
        } else {
            folder.path.join("/")
        };
        let items = walk::folder_items(folder.folder.as_ref());
        if !args.only.is_empty() {
            let matched = args
                .only
                .iter()
                .any(|pat| folder_name.to_lowercase().contains(&pat.to_lowercase()));
            if !matched {
                continue;
            }
        }

        let mut dir_created = false;
        let mut mbox: Option<BufWriter<fs::File>> = None;

        for item in items {
            if !args.all_classes
                && !item.class.as_deref().unwrap_or("").starts_with("IPM.Note")
            {
                continue;
            }
            if let Some(limit) = args.limit {
                if total >= limit {
                    break 'folders;
                }
            }

            let message = match walk::open_message(store, item.nid) {
                Ok(message) => message,
                Err(err) => {
                    errors += 1;
                    if error_notes < 20 {
                        eprintln!("  item {:#010x} in {folder_name}: {err}", item.nid);
                        error_notes += 1;
                    }
                    continue;
                }
            };
            let doc = eml::collect(&message, item.code_page);
            let text = eml::render(&doc, item.nid, &folder_name);

            if args.mbox {
                if mbox.is_none() {
                    let path = mbox_file_path(&args.out, &folder.path);
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|err| format!("{}: {err}", parent.display()))?;
                    }
                    let file = fs::File::create(&path)
                        .map_err(|err| format!("{}: {err}", path.display()))?;
                    mbox = Some(BufWriter::new(file));
                }
                let writer = mbox.as_mut().expect("mbox writer just created");
                append_mbox(writer, &text, doc.date)
                    .map_err(|err| format!("{folder_name}: {err}"))?;
            } else {
                if !dir_created {
                    let dir = eml_dir(&args.out, &folder.path);
                    fs::create_dir_all(&dir)
                        .map_err(|err| format!("{}: {err}", dir.display()))?;
                    dir_created = true;
                }
                let name = eml_name(doc.date, item.subject.as_deref(), total);
                let path = eml_dir(&args.out, &folder.path).join(name);
                fs::write(&path, &text).map_err(|err| format!("{}: {err}", path.display()))?;
            }

            total += 1;
            if total % 500 == 0 {
                eprintln!("  {total} exported ...");
            }
        }

        if let Some(mut writer) = mbox.take() {
            writer.flush().map_err(|err| format!("{folder_name}: {err}"))?;
            eprintln!("{folder_name}: mbox written");
        } else if !args.mbox && dir_created {
            eprintln!("{folder_name}: exported");
        }
    }

    eprintln!(
        "done: {total} exported, {errors} failed ({} shown)",
        error_notes.min(errors)
    );
    let stats = mail.stats();
    eprintln!(
        "io: {} block reads, {} MiB from disk, {} seeks, {} cache hits",
        stats.reads,
        stats.bytes / (1024 * 1024),
        stats.seeks,
        stats.hits
    );
    Ok(())
}

/// `<output>/<folder path>` for the EML tree; the top folder's own items go
/// straight into the output root.
fn eml_dir(out: &Path, path: &[String]) -> PathBuf {
    let mut dir = out.to_path_buf();
    for component in path {
        dir.push(sanitize_component(component));
    }
    dir
}

/// `<output>/<folder path>.mbox`, the last component becoming the file.
fn mbox_file_path(out: &Path, path: &[String]) -> PathBuf {
    let mut file = out.to_path_buf();
    if path.is_empty() {
        return file.join("ROOT.mbox");
    }
    for component in &path[..path.len() - 1] {
        file.push(sanitize_component(component));
    }
    file.push(sanitize_component(&path[path.len() - 1]) + ".mbox");
    file
}

/// One EML file's name: `<seq>_<date>_<subject>.eml`.
fn eml_name(date: Option<i64>, subject: Option<&str>, seq: u64) -> String {
    let date = date
        .map(props::filetime_compact)
        .unwrap_or_else(|| "nodate".into());
    let subject = sanitize_text(subject.unwrap_or("(no subject)"), 80);
    format!("{seq:06}_{date}_{subject}.eml")
}

/// A folder or file name component: Windows-illegal characters replaced,
/// trailing dots and spaces dropped.
fn sanitize_component(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.is_empty() {
        "_".into()
    } else {
        out
    }
}

/// A subject fit for a file name, cut to `max` characters.
fn sanitize_text(text: &str, max: usize) -> String {
    let mut out: String = text
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
            {
                ' '
            } else {
                c
            }
        })
        .collect();
    if let Some((index, _)) = out.char_indices().nth(max) {
        out.truncate(index);
    }
    out = out.trim().trim_end_matches('.').trim_end().to_string();
    if out.is_empty() {
        "untitled".into()
    } else {
        out
    }
}

/// Append one message to an mboxo file: a `From ` separator line, the message
/// with `From ` body lines escaped, and a blank line after.
fn append_mbox(writer: &mut BufWriter<fs::File>, message: &str, date: Option<i64>) -> io::Result<()> {
    let date = date
        .map(props::filetime_rfc2822)
        .unwrap_or_default();
    writeln!(writer, "From MAILER-DAEMON {date}")?;
    for line in message.lines() {
        if line.starts_with("From ") {
            writer.write_all(b">")?;
        }
        writer.write_all(line.as_bytes())?;
        writer.write_all(b"\n")?;
    }
    writer.write_all(b"\n")?;
    Ok(())
}

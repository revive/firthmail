//! Opening an OST/PST and walking its folder and message tree.
//!
//! Everything here works on the concrete Unicode types: reading an
//! attachment's data needs `Rc<UnicodeMessage>`, which the `dyn Store`
//! entry point does not hand out.

use std::cell::Cell;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::rc::Rc;

use outlook_pst::messaging::folder::{Folder, UnicodeFolder};
use outlook_pst::messaging::message::UnicodeMessage;
use outlook_pst::messaging::store::{Store, UnicodeStore};
use outlook_pst::ndb::node_id::NodeId;
use outlook_pst::UnicodePstFile;

use crate::cache::{CachedReader, IoStats};
use crate::props::{self, DEFAULT_CODE_PAGE, MESSAGE_CLASS, MESSAGE_CODEPAGE, MESSAGE_PROPS, SUBJECT};

/// The root folder's node id.
const NID_ROOT_FOLDER: u32 = 0x122;

/// An open OST/PST, plus the handle to its read statistics.
pub struct MailFile {
    store: Rc<UnicodeStore>,
    stats: Rc<Cell<IoStats>>,
}

impl MailFile {
    pub fn store(&self) -> &Rc<UnicodeStore> {
        &self.store
    }

    /// The store's display name (`Personal Folders`, an account address).
    pub fn display_name(&self) -> String {
        self.store
            .properties()
            .display_name()
            .unwrap_or_default()
            .trim_end_matches('\0')
            .to_string()
    }

    pub fn stats(&self) -> IoStats {
        self.stats.get()
    }
}

/// Open an OST/PST. Supports the Unicode PST layout (wVer 23) and the
/// 4 KiB-page OST layout Outlook 2013 introduced (wVer 36); ANSI files
/// (wVer 14/15) are rejected for now.
///
/// The file is read through a block cache: walking a B-tree file is many
/// small reads at scattered offsets, and the same pages are read again
/// and again.
pub fn open(path: &Path, cache_mib: usize) -> io::Result<MailFile> {
    let mut magic = [0u8; 12];
    File::open(path)?.read_exact(&mut magic)?;
    if &magic[..4] != b"!BDN" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "not a PST or OST file"));
    }
    let version = u16::from_le_bytes([magic[10], magic[11]]);
    match version {
        23 | 36 => {}
        14 | 15 => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ANSI (Outlook 97-2002) format is not supported yet",
            ));
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported PST/OST layout version {other}"),
            ));
        }
    }

    // 256 KiB blocks, `cache_mib` MiB of them, in front of the file.
    let reader = CachedReader::new(File::open(path)?, 256 * 1024, (cache_mib * 4).max(16))?;
    let stats = reader.stats();
    let pst = Rc::new(UnicodePstFile::read_from(Box::new(reader))?);
    let store = UnicodeStore::read(pst)?;
    Ok(MailFile { store, stats })
}

/// A folder and its path from the top of the mailbox, e.g. `["Inbox", "Projects"]`.
pub struct FolderRef {
    pub folder: Rc<UnicodeFolder>,
    pub path: Vec<String>,
}

/// Every folder under the top of the mailbox, parents before children, in
/// table order.
pub fn collect(store: &Rc<UnicodeStore>) -> io::Result<Vec<FolderRef>> {
    let top = top_folder(store)?;
    let mut out = Vec::new();
    let mut stack = vec![(top, Vec::<String>::new())];
    while let Some((folder, path)) = stack.pop() {
        let mut subs = subfolders(store, folder.as_ref());
        // A stack pops last-in first: push the subfolders reversed so the
        // walk stays in table order.
        subs.reverse();
        for sub in subs {
            let mut sub_path = path.clone();
            sub_path.push(display_name(sub.as_ref()));
            stack.push((sub, sub_path));
        }
        out.push(FolderRef { folder, path });
    }
    Ok(out)
}

fn display_name(folder: &UnicodeFolder) -> String {
    folder
        .properties()
        .display_name()
        .unwrap_or_default()
        .trim_end_matches('\0')
        .to_string()
}

/// The top of the mailbox: the IPM subtree the store names, or, in an OST,
/// the `IPM_SUBTREE` folder under the root.
fn top_folder(store: &Rc<UnicodeStore>) -> io::Result<Rc<UnicodeFolder>> {
    match store.properties().ipm_sub_tree_entry_id() {
        Ok(entry_id) => UnicodeFolder::read(store.clone(), &entry_id),
        Err(_) => ost_top_folder(store),
    }
}

/// An OST's store names no IPM subtree. Its root holds "Root - Mailbox" and
/// "Root - Public", each with an `IPM_SUBTREE` below: take the first one
/// that has folders in it, else the root itself.
/// (Approach from pst-markdown, MIT OR Apache-2.0.)
fn ost_top_folder(store: &Rc<UnicodeStore>) -> io::Result<Rc<UnicodeFolder>> {
    let root = open_folder(store, NID_ROOT_FOLDER)?;
    for top in subfolders(store, root.as_ref()) {
        for folder in subfolders(store, top.as_ref()) {
            let name = display_name(folder.as_ref());
            let has_folders = folder
                .hierarchy_table()
                .is_some_and(|table| table.rows_matrix().next().is_some());
            if name.trim_end_matches('\0') == "IPM_SUBTREE" && has_folders {
                return Ok(folder);
            }
        }
    }
    Ok(root)
}

fn open_folder(store: &Rc<UnicodeStore>, nid: u32) -> io::Result<Rc<UnicodeFolder>> {
    let entry_id = store.properties().make_entry_id(NodeId::from(nid))?;
    UnicodeFolder::read(store.clone(), &entry_id)
}

/// A folder's subfolders that open, in table order.
fn subfolders(store: &Rc<UnicodeStore>, folder: &UnicodeFolder) -> Vec<Rc<UnicodeFolder>> {
    let Some(table) = folder.hierarchy_table() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in table.rows_matrix() {
        if let Ok(folder) = open_folder(store, u32::from(row.id())) {
            out.push(folder);
        }
    }
    out
}

/// One item as its folder's contents table lists it, before it is opened.
#[derive(Debug, Clone)]
pub struct ItemRef {
    /// The item's node id: unique in the file.
    pub nid: u32,
    /// `IPM.Note` for mail; `IPM.Appointment`, `IPM.Contact`, ...
    pub class: Option<String>,
    pub subject: Option<String>,
    pub code_page: u32,
}

/// The items of one folder, in table order. Opening each item is a separate
/// step, so one broken item never stops the walk.
pub fn folder_items(folder: &UnicodeFolder) -> Vec<ItemRef> {
    let Some(table) = folder.contents_table() else {
        return Vec::new();
    };
    let wanted = [MESSAGE_CLASS, SUBJECT, MESSAGE_CODEPAGE];
    let context = table.context();
    let columns: Vec<_> = context
        .columns()
        .iter()
        .enumerate()
        .filter(|(_, column)| wanted.contains(&column.prop_id()))
        .map(|(index, column)| (index, column.prop_id(), column.prop_type()))
        .collect();

    let mut out = Vec::new();
    for row in table.rows_matrix() {
        let nid = u32::from(row.id());
        let Ok(values) = row.columns(context) else {
            continue;
        };

        // The code page first: it says how the two strings are encoded.
        let mut code_page = DEFAULT_CODE_PAGE;
        for (index, prop_id, prop_type) in &columns {
            if *prop_id == MESSAGE_CODEPAGE
                && let Some(Some(value)) = values.get(*index)
                && let Ok(value) = table.read_column(value, *prop_type)
                && let Some(cp) = props::integer(Some(&value))
            {
                code_page = cp as u32;
            }
        }

        let mut class = None;
        let mut subject = None;
        for (index, prop_id, prop_type) in &columns {
            let Some(Some(value)) = values.get(*index) else {
                continue;
            };
            let Ok(value) = table.read_column(value, *prop_type) else {
                continue;
            };
            match *prop_id {
                MESSAGE_CLASS => class = props::string(Some(&value), code_page),
                SUBJECT => subject = props::subject(Some(&value), code_page),
                _ => {}
            }
        }
        out.push(ItemRef {
            nid,
            class,
            subject,
            code_page,
        });
    }
    out
}

/// Open one message, reading only the properties `ost2eml` uses.
pub fn open_message(store: &Rc<UnicodeStore>, nid: u32) -> io::Result<Rc<UnicodeMessage>> {
    let entry_id = store.properties().make_entry_id(NodeId::from(nid))?;
    UnicodeMessage::read(store.clone(), &entry_id, Some(MESSAGE_PROPS))
}

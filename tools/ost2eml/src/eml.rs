//! Turning one message into EML: headers from the stored transport headers
//! (`PR_TRANSPORT_MESSAGE_HEADERS`) with MAPI properties filling the gaps,
//! and a MIME body rebuilt from the stored HTML/text with the attachments
//! as parts.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use outlook_pst::ltp::prop_context::PropertyValue;
use outlook_pst::ltp::table_context::TableContext;
use outlook_pst::messaging::attachment::{Attachment, AttachmentData, UnicodeAttachment};
use outlook_pst::messaging::message::{Message, MessageProperties, UnicodeMessage};
use outlook_pst::ndb::node_id::NodeId;

use crate::props;

/// Everything one message carries, after the MAPI layer is read.
pub struct MailDoc {
    /// The original RFC 822 header block the server sent, as Outlook stored it.
    pub transport: Option<String>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    /// The FILETIME to use as the message date, if any.
    pub date: Option<i64>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<AttachmentPart>,
}

/// One attachment, with its data ready for a MIME part.
pub struct AttachmentPart {
    pub filename: String,
    /// `PR_ATTACH_MIME_TAG`, e.g. `application/pdf`; guessed when empty.
    pub mime: String,
    pub data: PartData,
}

pub enum PartData {
    Bytes(Vec<u8>),
    /// An embedded message, already rendered as EML text.
    Embedded(String),
}

/// Read one message's everything, attachments included.
pub fn collect(message: &Rc<UnicodeMessage>, code_page: u32) -> MailDoc {
    let attachments = attachments(message, code_page);
    collect_common(message.as_ref(), code_page, attachments)
}

/// Read an embedded message (a `dyn Message`). Its own attachments are left
/// out: reaching their data needs the concrete message type, which the trait
/// object does not carry. Embedded messages with attachments are rare.
fn collect_dyn(message: &dyn Message, code_page: u32) -> MailDoc {
    collect_common(message, code_page, Vec::new())
}

fn collect_common(message: &dyn Message, code_page: u32, attachments: Vec<AttachmentPart>) -> MailDoc {
    let properties = message.properties();
    let get = |id: u16| properties.get(id);
    // The message's own code page beats the one its folder's table carried.
    let cp = props::integer(get(props::INTERNET_CPID))
        .or_else(|| props::integer(get(props::MESSAGE_CODEPAGE)))
        .map_or(code_page, |cp| cp as u32);
    let text = |id: u16| {
        props::string(get(id), cp)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    let (to, cc) = recipients(message, cp);

    MailDoc {
        transport: text(props::TRANSPORT_MESSAGE_HEADERS),
        subject: props::subject(get(props::SUBJECT), cp),
        from: sender(properties, cp).map(|m| format_mailbox(&m)),
        to: to.iter().map(|m| format_mailbox(m)).collect(),
        cc: cc.iter().map(|m| format_mailbox(m)).collect(),
        date: props::time(get(props::CLIENT_SUBMIT_TIME))
            .or_else(|| props::time(get(props::DELIVERY_TIME)))
            .or_else(|| props::time(get(props::CREATION_TIME))),
        message_id: text(props::INTERNET_MESSAGE_ID),
        in_reply_to: text(props::IN_REPLY_TO),
        text: text(props::BODY),
        html: props::binary(get(props::HTML))
            .map(|bytes| props::decode(bytes, cp))
            .filter(|s| !s.trim().is_empty()),
        attachments,
    }
}

/// A parsed mailbox: a display name and an address.
struct Mailbox {
    name: Option<String>,
    address: String,
}

/// An address only when the address type says it is SMTP.
fn smtp(kind: Option<String>, address: Option<String>) -> Option<String> {
    kind.filter(|k| k.eq_ignore_ascii_case("SMTP")).and(address)
}

/// A mailbox from a name and candidate addresses, preferring one with `@`.
/// An Exchange address (`/O=.../CN=...`) is kept only when there is nothing
/// better. (Approach from pst-markdown, MIT OR Apache-2.0.)
fn mailbox(name: Option<String>, addresses: [Option<String>; 5]) -> Option<Mailbox> {
    let candidates: Vec<String> = addresses.into_iter().flatten().collect();
    let address = candidates
        .iter()
        .find(|a| a.contains('@'))
        .or(candidates.first())
        .cloned();
    match (name, address) {
        (name, Some(address)) => {
            let name = name
                .map(|n| n.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|n| *n != address);
            Some(Mailbox { name, address })
        }
        (Some(name), None) => Some(Mailbox {
            name: None,
            address: name,
        }),
        (None, None) => None,
    }
}

fn sender(properties: &MessageProperties, cp: u32) -> Option<Mailbox> {
    let text = |id: u16| {
        props::string(properties.get(id), cp)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    mailbox(
        text(props::SENT_REPRESENTING_NAME).or_else(|| text(props::SENDER_NAME)),
        [
            text(props::SENDER_SMTP_ADDRESS),
            text(props::SENT_REPRESENTING_SMTP_ADDRESS),
            smtp(text(props::SENDER_ADDRTYPE), text(props::SENDER_EMAIL)),
            text(props::SENT_REPRESENTING_EMAIL),
            text(props::SENDER_EMAIL),
        ],
    )
}

fn recipients(message: &dyn Message, cp: u32) -> (Vec<Mailbox>, Vec<Mailbox>) {
    let (mut to, mut cc) = (Vec::new(), Vec::new());
    let Some(table) = message.recipient_table() else {
        return (to, cc);
    };
    let wanted = [
        props::RECIPIENT_TYPE,
        props::DISPLAY_NAME,
        props::ADDRTYPE,
        props::EMAIL_ADDRESS,
        props::SMTP_ADDRESS,
    ];
    for (_, values) in table_rows(table.as_ref(), &wanted) {
        let text = |id: u16| {
            props::string(values.get(&id), cp)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let Some(mbox) = mailbox(
            text(props::DISPLAY_NAME),
            [
                text(props::SMTP_ADDRESS),
                smtp(text(props::ADDRTYPE), text(props::EMAIL_ADDRESS)),
                text(props::EMAIL_ADDRESS),
                None,
                None,
            ],
        ) else {
            continue;
        };
        match props::integer(values.get(&props::RECIPIENT_TYPE)).map(|t| t & 0xF) {
            Some(1) => to.push(mbox),
            Some(2) => cc.push(mbox),
            _ => {}
        }
    }
    (to, cc)
}

fn attachments(message: &Rc<UnicodeMessage>, cp: u32) -> Vec<AttachmentPart> {
    let Some(table) = message.attachment_table() else {
        return Vec::new();
    };
    let wanted = [
        props::ATTACH_LONG_FILENAME,
        props::ATTACH_FILENAME,
        props::DISPLAY_NAME,
        props::ATTACH_MIME_TAG,
    ];
    let mut out = Vec::new();
    for (nid, values) in table_rows(table.as_ref(), &wanted) {
        let text = |id: u16| {
            props::string(values.get(&id), cp)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let filename = text(props::ATTACH_LONG_FILENAME)
            .or_else(|| text(props::ATTACH_FILENAME))
            .or_else(|| text(props::DISPLAY_NAME))
            .unwrap_or_else(|| format!("attachment-{nid}"));
        let mime = text(props::ATTACH_MIME_TAG).unwrap_or_default();
        let Ok(attachment) = UnicodeAttachment::read(message.clone(), NodeId::from(nid), None)
        else {
            continue;
        };
        let data = match attachment.data() {
            Some(AttachmentData::Binary(value)) => PartData::Bytes(value.buffer().to_vec()),
            Some(AttachmentData::Message(inner)) => {
                // An attached message (.eml), stored as an embedded message.
                let doc = collect_dyn(inner.as_ref(), cp);
                PartData::Embedded(render(&doc, nid, "embedded"))
            }
            None => continue,
        };
        out.push(AttachmentPart {
            filename,
            mime,
            data,
        });
    }
    out
}

/// The rows of a table: each row's id and the `wanted` columns it has. A row
/// that cannot be decoded is left out. (From pst-markdown, adapted.)
fn table_rows(
    table: &dyn TableContext,
    wanted: &[u16],
) -> Vec<(u32, HashMap<u16, PropertyValue>)> {
    let context = table.context();
    let columns: Vec<_> = context
        .columns()
        .iter()
        .enumerate()
        .filter(|(_, column)| wanted.contains(&column.prop_id()))
        .collect();
    let mut out = Vec::new();
    for row in table.rows_matrix() {
        let id = u32::from(row.id());
        let Ok(values) = row.columns(context) else {
            continue;
        };
        let mut found = HashMap::new();
        for (index, column) in &columns {
            if let Some(Some(value)) = values.get(*index)
                && let Ok(value) = table.read_column(value, column.prop_type())
            {
                found.insert(column.prop_id(), value);
            }
        }
        out.push((id, found));
    }
    out
}

// ---- EML rendering ----

/// Render one message as EML text (CRLF line endings).
///
/// Headers come from the stored transport headers first — they keep the
/// original `Received` chain, RFC 2047 encoded words, and list headers —
/// with the structural MIME headers and `Bcc` dropped and rebuilt here.
/// Whatever they lack is filled from the MAPI properties.
pub fn render(doc: &MailDoc, nid: u32, folder: &str) -> String {
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut have: HashSet<String> = HashSet::new();

    if let Some(transport) = doc.transport.as_deref() {
        for (name, value) in parse_headers(transport) {
            let lower = name.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "content-type" | "mime-version" | "content-transfer-encoding" | "bcc"
            ) {
                continue;
            }
            if value.trim().is_empty() || have.contains(&lower) {
                continue; // first one wins
            }
            have.insert(lower.clone());
            headers.push((name, value));
        }
    }

    let add = |headers: &mut Vec<(String, String)>, have: &mut HashSet<String>, name: &str, value: Option<String>| {
        if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
            let lower = name.to_ascii_lowercase();
            if !have.contains(&lower) {
                have.insert(lower);
                headers.push((name.to_string(), value));
            }
        }
    };
    add(&mut headers, &mut have, "From", doc.from.clone());
    add(
        &mut headers,
        &mut have,
        "To",
        (!doc.to.is_empty()).then(|| doc.to.join(", ")),
    );
    add(
        &mut headers,
        &mut have,
        "Cc",
        (!doc.cc.is_empty()).then(|| doc.cc.join(", ")),
    );
    add(
        &mut headers,
        &mut have,
        "Subject",
        doc.subject.as_deref().map(rfc2047),
    );
    add(
        &mut headers,
        &mut have,
        "Date",
        doc.date
            .map(|ft| props::filetime_rfc2822(ft))
            .filter(|s| !s.is_empty()),
    );
    add(
        &mut headers,
        &mut have,
        "Message-ID",
        doc.message_id
            .clone()
            .or_else(|| Some(format!("<firthmail-{nid:x}@outlook-converted.invalid>"))),
    );
    add(&mut headers, &mut have, "In-Reply-To", doc.in_reply_to.clone());
    // Provenance, so an import can be traced back to the source folder.
    headers.push(("X-FirthMail-Folder".into(), folder.to_string()));
    headers.push(("X-FirthMail-Node".into(), format!("{nid:#010x}")));

    let mut out = String::new();
    for (name, value) in &headers {
        out.push_str(name);
        out.push_str(": ");
        out.push_str(&scrub(value));
        out.push_str("\r\n");
    }
    out.push_str("MIME-Version: 1.0\r\n");

    // The body: a text part, with alternatives when both forms exist,
    // and the attachments after it in a mixed container.
    let text_part = doc.text.as_deref().map(|t| {
        encoded_part("text/plain; charset=utf-8", t.as_bytes())
    });
    let html_part = doc.html.as_deref().map(|h| {
        encoded_part("text/html; charset=utf-8", h.as_bytes())
    });
    let body = match (text_part, html_part) {
        (Some(text), Some(html)) => multipart(&boundary_for(doc, nid, "alt"), &[text, html], "alternative"),
        (None, Some(html)) => html,
        (Some(text), None) => text,
        (None, None) => "Content-Type: text/plain; charset=utf-8\r\n\r\n".into(),
    };

    if doc.attachments.is_empty() {
        out.push_str(&body);
    } else {
        let mut parts = vec![body];
        parts.extend(doc.attachments.iter().map(attachment_part));
        out.push_str(&multipart(&boundary_for(doc, nid, "mix"), &parts, "mixed"));
    }
    out
}

/// A boundary string: unique inside one message.
fn boundary_for(doc: &MailDoc, nid: u32, kind: &str) -> String {
    format!("----=_firthmail_{kind}_{nid:x}_{:x}", doc.date.unwrap_or(0) as u32)
}

fn multipart(boundary: &str, parts: &[String], kind: &str) -> String {
    let mut out = format!("Content-Type: multipart/{kind}; boundary=\"{boundary}\"\r\n\r\n");
    for part in parts {
        out.push_str("--");
        out.push_str(boundary);
        out.push_str("\r\n");
        out.push_str(part);
        out.push_str("\r\n");
    }
    out.push_str("--");
    out.push_str(boundary);
    out.push_str("--\r\n");
    out
}

/// A base64-encoded text part; base64 keeps any stored content safe.
fn encoded_part(content_type: &str, body: &[u8]) -> String {
    let mut part = format!(
        "Content-Type: {content_type}\r\nContent-Transfer-Encoding: base64\r\n\r\n"
    );
    part.push_str(&wrap76(&BASE64.encode(body)));
    part.push('\n');
    part
}

fn attachment_part(attachment: &AttachmentPart) -> String {
    let mime = if attachment.mime.is_empty() {
        guess_mime(&attachment.filename)
    } else {
        attachment.mime.clone()
    };
    let name = mime_param("name", &attachment.filename);
    let filename = mime_param("filename", &attachment.filename);
    let mut part = format!(
        "Content-Type: {mime}; {name}\r\nContent-Disposition: attachment; {filename}\r\n"
    );
    match &attachment.data {
        PartData::Bytes(bytes) => {
            part.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
            part.push_str(&wrap76(&BASE64.encode(bytes)));
        }
        PartData::Embedded(eml) => {
            part.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
            part.push_str(eml);
        }
    }
    part.push('\n');
    part
}

/// `name="..."` when the value is plain ASCII, RFC 2231 when it is not.
fn mime_param(param: &str, value: &str) -> String {
    if value.is_ascii() && !value.contains('"') && !value.contains('\\') {
        format!("{param}=\"{value}\"")
    } else {
        let mut encoded = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_') {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        format!("{param}*=utf-8''{encoded}")
    }
}

fn guess_mime(filename: &str) -> String {
    let ext = filename
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" | "pps" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" => "text/plain",
        "htm" | "html" => "text/html",
        "csv" => "text/csv",
        "eml" => "message/rfc822",
        "msg" => "application/vnd.ms-outlook",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
    .into()
}

/// Base64 in lines of at most 76 characters.
fn wrap76(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + s.len() / 76 * 2 + 2);
    let mut line = 0;
    for ch in s.chars() {
        if line == 76 {
            out.push_str("\r\n");
            line = 0;
        }
        out.push(ch);
        line += 1;
    }
    out
}

/// `Name: value` pairs from a raw RFC 822 header block, continuations folded
/// back in. Damaged lines are skipped.
fn parse_headers(raw: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        if (line.starts_with(' ') || line.starts_with('\t')) && current.is_some() {
            if let Some((_, value)) = current.as_mut() {
                value.push(' ');
                value.push_str(line.trim());
            }
            continue;
        }
        if let Some(done) = current.take() {
            out.push(done);
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_string();
            if name.is_empty() || name.chars().any(|c| c.is_control() || c.is_whitespace()) {
                continue;
            }
            current = Some((name, value.trim_start().to_string()));
        }
    }
    if let Some(done) = current {
        out.push(done);
    }
    out
}

/// Strip line breaks and NULs so a stored value cannot forge its own header.
fn scrub(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '\r' && *c != '\n' && *c != '\0')
        .collect()
}

/// RFC 2047 encode a header value when it is not plain ASCII.
fn rfc2047(s: &str) -> String {
    if s.is_ascii() {
        s.to_string()
    } else {
        format!("=?UTF-8?B?{}?=", BASE64.encode(s.as_bytes()))
    }
}

fn format_mailbox(m: &Mailbox) -> String {
    match &m.name {
        Some(name) if !name.is_empty() && *name != m.address => {
            let name = rfc2047(name).replace('"', "'");
            format!("\"{name}\" <{}>", m.address)
        }
        _ => m.address.clone(),
    }
}

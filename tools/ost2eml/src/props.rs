//! MAPI property ids (from MS-OXPROPS) and small value helpers.
//!
//! The `string` / `subject` / `decode` / `charset_name` helpers are adapted
//! from pst-markdown's `props.rs`
//! (MIT OR Apache-2.0, https://github.com/lwm-luminx/markdown-extract).

use mail_parser::decoders::charsets::map::charset_decoder;
use outlook_pst::ltp::prop_context::PropertyValue;

// ---- message ----
pub const MESSAGE_CLASS: u16 = 0x001A;
pub const TRANSPORT_MESSAGE_HEADERS: u16 = 0x007D;
pub const SUBJECT: u16 = 0x0037;
pub const CLIENT_SUBMIT_TIME: u16 = 0x0039;
pub const SENT_REPRESENTING_NAME: u16 = 0x0042;
pub const SENT_REPRESENTING_EMAIL: u16 = 0x0065;
pub const SENDER_NAME: u16 = 0x0C1A;
pub const SENDER_ADDRTYPE: u16 = 0x0C1E;
pub const SENDER_EMAIL: u16 = 0x0C1F;
pub const DELIVERY_TIME: u16 = 0x0E06;
pub const MESSAGE_SIZE: u16 = 0x0E08;
pub const BODY: u16 = 0x1000;
pub const HTML: u16 = 0x1013;
pub const INTERNET_MESSAGE_ID: u16 = 0x1035;
pub const IN_REPLY_TO: u16 = 0x1042;
pub const CREATION_TIME: u16 = 0x3007;
pub const LAST_MODIFICATION_TIME: u16 = 0x3008;
pub const INTERNET_CPID: u16 = 0x3FDE;
pub const MESSAGE_CODEPAGE: u16 = 0x3FFD;
pub const SENDER_SMTP_ADDRESS: u16 = 0x5D01;
pub const SENT_REPRESENTING_SMTP_ADDRESS: u16 = 0x5D02;

// ---- recipients ----
pub const RECIPIENT_TYPE: u16 = 0x0C15;
pub const DISPLAY_NAME: u16 = 0x3001;
pub const ADDRTYPE: u16 = 0x3002;
pub const EMAIL_ADDRESS: u16 = 0x3003;
pub const SMTP_ADDRESS: u16 = 0x39FE;

// ---- attachments ----
pub const ATTACH_DATA_BIN: u16 = 0x3701;
pub const ATTACH_FILENAME: u16 = 0x3704;
pub const ATTACH_METHOD: u16 = 0x3705;
pub const ATTACH_LONG_FILENAME: u16 = 0x3707;
pub const ATTACH_MIME_TAG: u16 = 0x370E;

/// The code page assumed for 8-bit strings that do not name one.
pub const DEFAULT_CODE_PAGE: u32 = 1252;

/// The set of message properties `ost2eml` reads from each message.
pub const MESSAGE_PROPS: &[u16] = &[
    MESSAGE_CLASS,
    TRANSPORT_MESSAGE_HEADERS,
    SUBJECT,
    CLIENT_SUBMIT_TIME,
    SENT_REPRESENTING_NAME,
    SENT_REPRESENTING_EMAIL,
    SENDER_NAME,
    SENDER_ADDRTYPE,
    SENDER_EMAIL,
    DELIVERY_TIME,
    BODY,
    HTML,
    INTERNET_MESSAGE_ID,
    IN_REPLY_TO,
    CREATION_TIME,
    INTERNET_CPID,
    MESSAGE_CODEPAGE,
    SENDER_SMTP_ADDRESS,
    SENT_REPRESENTING_SMTP_ADDRESS,
];

/// A string property, decoding 8-bit strings in `code_page`. Trailing NULs are dropped.
pub fn string(value: Option<&PropertyValue>, code_page: u32) -> Option<String> {
    let text = match value? {
        PropertyValue::Unicode(value) => String::from_utf16_lossy(value.buffer()),
        PropertyValue::String8(value) => decode(value.buffer(), code_page),
        _ => return None,
    };
    Some(text.trim_end_matches('\0').to_string())
}

/// A subject: Outlook may store it with a prefix marker, `0x01` then the prefix length.
pub fn subject(value: Option<&PropertyValue>, code_page: u32) -> Option<String> {
    let text = string(value, code_page)?;
    let mut chars = text.chars();
    let text = if chars.next() == Some('\u{1}') {
        chars.next();
        chars.as_str().to_string()
    } else {
        text
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

pub fn integer(value: Option<&PropertyValue>) -> Option<i64> {
    match value? {
        PropertyValue::Integer16(v) => Some(i64::from(*v)),
        PropertyValue::Integer32(v) => Some(i64::from(*v)),
        PropertyValue::Integer64(v) => Some(*v),
        _ => None,
    }
}

pub fn binary(value: Option<&PropertyValue>) -> Option<&[u8]> {
    match value? {
        PropertyValue::Binary(value) => Some(value.buffer()),
        _ => None,
    }
}

/// A `PtypTime` as a raw FILETIME, when it is set at all.
pub fn time(value: Option<&PropertyValue>) -> Option<i64> {
    match value? {
        PropertyValue::Time(filetime) if *filetime > 0 => Some(*filetime),
        _ => None,
    }
}

/// Bytes in a Windows code page as text; unknown code pages read as Windows-1252.
pub fn decode(bytes: &[u8], code_page: u32) -> String {
    if code_page == 65001 || code_page == 20127 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let decoder = charset_name(code_page).and_then(|name| charset_decoder(name.as_bytes()));
    match decoder.or_else(|| charset_decoder(b"windows-1252")) {
        Some(decode) => decode(bytes),
        None => String::from_utf8_lossy(bytes).into_owned(),
    }
}

fn charset_name(code_page: u32) -> Option<String> {
    Some(match code_page {
        874 => "windows-874".into(),
        932 => "shift_jis".into(),
        936 => "gbk".into(),
        949 => "euc-kr".into(),
        950 => "big5".into(),
        1250..=1258 => format!("windows-{code_page}"),
        10000 => "macintosh".into(),
        20866 => "koi8-r".into(),
        21866 => "koi8-u".into(),
        28591..=28599 => format!("iso-8859-{}", code_page - 28590),
        28603 => "iso-8859-13".into(),
        28605 => "iso-8859-15".into(),
        50220..=50222 => "iso-2022-jp".into(),
        51932 => "euc-jp".into(),
        51949 => "euc-kr".into(),
        54936 => "gb18030".into(),
        _ => return None,
    })
}

// ---- FILETIME helpers ----

/// 100-nanosecond intervals since 1601-01-01 UTC, as seconds since 1970-01-01 UTC.
pub fn filetime_unix(filetime: i64) -> Option<i64> {
    if filetime <= 0 {
        return None;
    }
    const UNIX_EPOCH_FILETIME_SECONDS: i64 = 11_644_473_600;
    Some(filetime.div_euclid(10_000_000) - UNIX_EPOCH_FILETIME_SECONDS)
}

/// A `PtypTime` as an RFC 2822 date: `Tue, 04 Nov 2026 07:05:09 +0000`.
pub fn filetime_rfc2822(filetime: i64) -> String {
    let Some(seconds) = filetime_unix(filetime) else {
        return String::new();
    };
    let days = seconds.div_euclid(86_400);
    let in_day = seconds.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    // 1970-01-01 was a Thursday.
    let weekday = WEEKDAYS[usize::try_from((days + 4).rem_euclid(7)).unwrap_or(0)];
    let month = MONTHS[(m - 1) as usize];
    format!(
        "{weekday}, {d:02} {month} {y} {:02}:{:02}:{:02} +0000",
        in_day / 3600,
        in_day / 60 % 60,
        in_day % 60
    )
}

/// A `PtypTime` compact for file names: `20261123T153005Z`.
pub fn filetime_compact(filetime: i64) -> String {
    let Some(seconds) = filetime_unix(filetime) else {
        return "nodate".into();
    };
    let days = seconds.div_euclid(86_400);
    let in_day = seconds.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        in_day / 3600,
        in_day / 60 % 60,
        in_day % 60
    )
}

/// Days since 1970-01-01 as (year, month [1-12], day [1-31]).
/// Howard Hinnant's `civil_from_days` algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetimes() {
        assert_eq!(filetime_rfc2822(116_444_736_000_000_000), "Thu, 01 Jan 1970 00:00:00 +0000");
        // 2001-10-24T17:07:37Z, a Wednesday.
        assert_eq!(
            filetime_rfc2822(126_484_168_570_000_000),
            "Wed, 24 Oct 2001 17:07:37 +0000"
        );
        assert_eq!(filetime_compact(126_484_168_570_000_000), "20011024T170737Z");
    }

    #[test]
    fn code_pages() {
        assert_eq!(decode(b"Caf\xe9", 1252), "Café");
        assert_eq!(decode(b"Caf\xc3\xa9", 65001), "Café");
        assert_eq!(decode(b"\xcf\xf0\xe8", 1251), "При");
        assert_eq!(decode(b"\xd6\xd0\xce\xc4", 936), "中文");
    }
}

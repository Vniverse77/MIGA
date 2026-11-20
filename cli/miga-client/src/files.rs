//! Attachments (ENGINE.md section 11): reading a file, metadata checks, EXIF stripping, upload and
//! download of the encrypted blob. No image decoding: the CLI sends bytes as they are, minus metadata.
use crate::{Error, Result};
use miga_core::attach::{decrypt_file, encrypt_file, Att, MAX_ATTACHMENT};
use miga_core::to_hex;
use std::io::Read;
use std::time::Duration;

/// What a file looks like before it is encrypted.
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub w: u32,
    pub h: u32,
    /// Metadata was removed from the file (JPEG EXIF/XMP/comments, PNG text and EXIF chunks).
    pub stripped: bool,
}

/// `sniffMime`
pub fn sniff_mime(b: &[u8]) -> &'static str {
    let at = |i: usize, s: &[u8]| b.get(i..i + s.len()) == Some(s);
    if at(0, &[0xff, 0xd8]) {
        "image/jpeg"
    } else if at(1, b"PNG") {
        "image/png"
    } else if at(0, b"GIF8") {
        "image/gif"
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        "image/webp"
    } else if at(4, b"ftyp") {
        if at(8, b"heic") || at(8, b"heix") || at(8, b"mif1") {
            "image/heic"
        } else {
            "video/mp4"
        }
    } else if at(0, &[0x1a, 0x45, 0xdf, 0xa3]) {
        "video/webm"
    } else {
        ""
    }
}

pub fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    }
}

fn be16(b: &[u8], i: usize) -> usize {
    usize::from(b[i]) << 8 | usize::from(b[i + 1])
}

fn be32(b: &[u8], i: usize) -> u32 {
    u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Width and height from the headers; `None` when they cannot be found.
pub fn dimensions(b: &[u8], mime: &str) -> Option<(u32, u32)> {
    match mime {
        "image/png" if b.len() >= 24 => Some((be32(b, 16), be32(b, 20))),
        "image/gif" if b.len() >= 10 => {
            Some((u32::from(u16::from_le_bytes([b[6], b[7]])), u32::from(u16::from_le_bytes([b[8], b[9]]))))
        }
        "image/jpeg" => {
            let mut i = 2;
            while i + 9 < b.len() {
                if b[i] != 0xff {
                    i += 1;
                    continue;
                }
                let m = b[i + 1];
                if m == 0xff {
                    i += 1;
                    continue;
                }
                if (0xc0..=0xcf).contains(&m) && !matches!(m, 0xc4 | 0xc8 | 0xcc) {
                    return Some((be16(b, i + 7) as u32, be16(b, i + 5) as u32));
                }
                if m == 0xd8 || m == 0x01 || (0xd0..=0xd7).contains(&m) {
                    i += 2;
                } else {
                    i += 2 + be16(b, i + 2);
                }
            }
            None
        }
        "image/webp" if b.len() >= 30 => match b.get(12..16)? {
            b"VP8X" => {
                let w = 1 + (u32::from(b[24]) | u32::from(b[25]) << 8 | u32::from(b[26]) << 16);
                let h = 1 + (u32::from(b[27]) | u32::from(b[28]) << 8 | u32::from(b[29]) << 16);
                Some((w, h))
            }
            b"VP8L" => {
                let v = u32::from_le_bytes([b[21], b[22], b[23], b[24]]);
                Some(((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1))
            }
            b"VP8 " => Some((
                u32::from(u16::from_le_bytes([b[26], b[27]]) & 0x3fff),
                u32::from(u16::from_le_bytes([b[28], b[29]]) & 0x3fff),
            )),
            _ => None,
        },
        _ => None,
    }
}

/// Removes metadata segments from a JPEG (APP1 EXIF/XMP, APP13, comments) and PNG (text, EXIF,
/// time chunks). Other formats are returned unchanged. Orientation is not applied.
pub fn strip_metadata(bytes: &[u8], mime: &str) -> (Vec<u8>, bool) {
    match mime {
        "image/jpeg" => strip_jpeg(bytes),
        "image/png" => strip_png(bytes),
        _ => (bytes.to_vec(), false),
    }
}

fn strip_jpeg(b: &[u8]) -> (Vec<u8>, bool) {
    let mut out = vec![0xff, 0xd8];
    let mut i = 2;
    let mut changed = false;
    while i + 4 <= b.len() {
        if b[i] != 0xff {
            break;
        }
        let m = b[i + 1];
        if m == 0xda {
            break; // start of scan: copy the rest as it is
        }
        let len = be16(b, i + 2);
        let end = (i + 2 + len).min(b.len());
        // APP1 (EXIF, XMP), APP12-APP15 (Ducky, Photoshop IRB, ...) and COM go; APP0 and the ICC profile stay.
        if matches!(m, 0xe1 | 0xec..=0xef | 0xfe) {
            changed = true;
        } else {
            out.extend_from_slice(&b[i..end]);
        }
        i = end;
    }
    out.extend_from_slice(&b[i.min(b.len())..]);
    (out, changed)
}

fn strip_png(b: &[u8]) -> (Vec<u8>, bool) {
    if b.len() < 8 {
        return (b.to_vec(), false);
    }
    let mut out = b[..8].to_vec();
    let mut i = 8;
    let mut changed = false;
    while i + 12 <= b.len() {
        let len = be32(b, i) as usize;
        let end = (i + 12 + len).min(b.len());
        match &b[i + 4..i + 8] {
            b"tEXt" | b"zTXt" | b"iTXt" | b"eXIf" | b"tIME" => changed = true,
            _ => out.extend_from_slice(&b[i..end]),
        }
        i = end;
    }
    out.extend_from_slice(&b[i.min(b.len())..]);
    (out, changed)
}

/// Reads and checks a file for sending.
pub fn prepare(path: &std::path::Path) -> Result<Prepared> {
    let meta = std::fs::metadata(path).map_err(|e| Error::Invalid(format!("{}: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(Error::Invalid("that is not a file".into()));
    }
    if meta.len() > MAX_ATTACHMENT as u64 {
        return Err(Error::Invalid("the file is larger than 25 MiB".into()));
    }
    let bytes = std::fs::read(path)?;
    let mime = sniff_mime(&bytes);
    if mime.is_empty() || mime == "image/heic" {
        return Err(Error::Invalid("only JPEG, PNG, WebP, GIF images and MP4/WebM video can be sent".into()));
    }
    if mime.starts_with("video/") {
        return Err(Error::Invalid(
            "sending video is not supported by the terminal client yet (receiving works)".into(),
        ));
    }
    let (bytes, stripped) = strip_metadata(&bytes, mime);
    let (w, h) = dimensions(&bytes, mime).ok_or_else(|| Error::Invalid("could not read the image size".into()))?;
    if !(1..=20_000).contains(&w) || !(1..=20_000).contains(&h) {
        return Err(Error::Invalid("the image is larger than 20000 pixels".into()));
    }
    Ok(Prepared { bytes, mime, w, h, stripped })
}

/// `https://host` for a relay URL `wss://host/ws`.
pub fn blob_base(relay: &str) -> String {
    let (scheme, rest) = if let Some(r) = relay.strip_prefix("wss://") {
        ("https", r)
    } else if let Some(r) = relay.strip_prefix("ws://") {
        ("http", r)
    } else {
        ("https", relay)
    };
    format!("{scheme}://{}/blob", rest.split('/').next().unwrap_or_default())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .user_agent(format!("miga-cli/{}", env!("CARGO_PKG_VERSION")))
        .http_status_as_error(false)
        .build()
        .into()
}

/// Encrypts and uploads; returns the attachment metadata (with our delete token).
pub fn upload(relay: &str, p: &Prepared) -> Result<Att> {
    let enc = encrypt_file(&p.bytes)?;
    let mut res = agent()
        .put(&blob_base(relay))
        .send(&enc.cipher[..])
        .map_err(|e| Error::Relay(format!("upload failed: {e}")))?;
    let status = res.status().as_u16();
    if status != 201 && status != 200 {
        return Err(Error::Relay(match status {
            413 => "the relay refuses files this large".into(),
            507 => "the relay's storage is full".into(),
            429 => "too many uploads right now; try again in a few minutes".into(),
            s => format!("upload failed (HTTP {s})"),
        }));
    }
    let text = res.body_mut().read_to_string().map_err(|e| Error::Relay(format!("bad upload answer: {e}")))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| Error::Relay(format!("bad upload answer: {e}")))?;
    let blob = v["id"].as_str().unwrap_or_default().to_string();
    let del = v["del"].as_str().map(str::to_string);
    Ok(Att {
        blob,
        key: enc.key,
        nonce: enc.nonce,
        hash: enc.hash,
        mime: p.mime.to_string(),
        size: p.bytes.len() as u64,
        w: p.w,
        h: p.h,
        thumb: String::new(),
        del,
    })
}

/// Downloads and verifies an attachment. `404` means gone (30 days or deleted by the sender).
pub fn download(relay: &str, att: &Att) -> Result<Vec<u8>> {
    let mut res = agent()
        .get(&format!("{}/{}", blob_base(relay), att.blob))
        .call()
        .map_err(|e| Error::Relay(format!("download failed: {e}")))?;
    match res.status().as_u16() {
        200 => {}
        404 => return Err(Error::Relay("the file is gone from the relay (files are kept 30 days)".into())),
        s => return Err(Error::Relay(format!("download failed (HTTP {s})"))),
    }
    let mut cipher = Vec::new();
    res.body_mut()
        .as_reader()
        .take(MAX_ATTACHMENT as u64 + 1024 * 1024)
        .read_to_end(&mut cipher)
        .map_err(|e| Error::Relay(format!("download failed: {e}")))?;
    Ok(decrypt_file(&cipher, &att.key, &att.nonce, &att.hash, att.size as usize)?)
}

/// Removes our uploaded copy (delete for everyone). Failures do not matter.
pub fn delete_blob(relay: &str, att: &Att) {
    if let Some(del) = &att.del {
        let _ = agent().delete(&format!("{}/{}", blob_base(relay), att.blob)).header("X-Delete-Token", del).call();
    }
}

/// A safe file name for a received attachment: the blob id plus the extension of its type.
pub fn saved_name(att: &Att) -> String {
    format!("miga-{}.{}", &att.blob[..8.min(att.blob.len())], ext_for(&att.mime))
}

pub fn hash_hex(b: &[u8]) -> String {
    to_hex(&miga_core::crypto::sha256(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
        // a tEXt chunk with a made-up comment, then IEND
        b.extend([0, 0, 0, 4, b't', b'E', b'X', b't', b'a', b'=', b'b', 0, 0, 0, 0, 0]);
        b.extend([0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]);
        b
    }

    #[test]
    fn png_size_and_text_chunks() {
        let b = png(640, 480);
        assert_eq!(sniff_mime(&b), "image/png");
        assert_eq!(dimensions(&b, "image/png"), Some((640, 480)));
        let (out, changed) = strip_metadata(&b, "image/png");
        assert!(changed && out.len() < b.len());
        assert!(!out.windows(4).any(|w| w == b"tEXt"));
        assert_eq!(dimensions(&out, "image/png"), Some((640, 480)));
    }

    #[test]
    fn jpeg_exif_is_removed_and_size_found() {
        let mut b = vec![0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0];
        b.extend([0xff, 0xe1, 0, 8, b'E', b'x', b'i', b'f', 0, 0]);
        b.extend([0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0]);
        b.extend([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
        assert_eq!(dimensions(&b, "image/jpeg"), Some((30, 20)));
        let (out, changed) = strip_metadata(&b, "image/jpeg");
        assert!(changed);
        assert!(!out.windows(4).any(|w| w == b"Exif"));
        assert_eq!(dimensions(&out, "image/jpeg"), Some((30, 20)));
        assert_eq!(&out[out.len() - 2..], &[0xff, 0xd9]);
    }

    #[test]
    fn blob_base_follows_the_relay() {
        assert_eq!(blob_base("wss://miga.vniverse77.com/ws"), "https://miga.vniverse77.com/blob");
        assert_eq!(blob_base("ws://127.0.0.1:18787/ws"), "http://127.0.0.1:18787/blob");
    }
}

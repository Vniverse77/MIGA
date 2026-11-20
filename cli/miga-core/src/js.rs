//! JavaScript semantics the protocol depends on: `String.length` in UTF-16 units, the exact
//! `trim()` / `\s` whitespace set, `Number(x)` coercion and base64 as `btoa` / `atob`.
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::{alphabet, Engine};
use serde_json::Value;

/// The ES WhiteSpace and LineTerminator code units (25). Excludes U+0085, U+200B and U+180E,
/// unlike Rust's `char::is_whitespace`.
pub fn is_js_space_unit(u: u16) -> bool {
    matches!(
        u,
        0x09..=0x0D
            | 0x20
            | 0xA0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

pub fn is_js_space(c: char) -> bool {
    u16::try_from(c as u32).map(is_js_space_unit).unwrap_or(false)
}

/// `String.prototype.trim` on a UTF-16 slice.
pub fn trim_units(s: &[u16]) -> &[u16] {
    let start = s.iter().position(|&u| !is_js_space_unit(u)).unwrap_or(s.len());
    let end = s.iter().rposition(|&u| !is_js_space_unit(u)).map_or(start, |i| i + 1);
    &s[start..end]
}

/// `s.trim()`
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.length` (UTF-16 code units).
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// `s.slice(0, n)` for UTF-16 units. A cut through a surrogate pair leaves a lone surrogate,
/// which a Rust `String` cannot hold: the lossy form is U+FFFD (see ENGINE.md, OPEN item 10).
pub fn slice_units_lossy(s: &str, n: usize) -> String {
    if utf16_len(s) <= n {
        return s.to_string();
    }
    String::from_utf16_lossy(&units(s)[..n])
}

/// `Number(value)` for a JSON value. `undefined` (a missing key) is `None` and gives NaN.
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(a)) => match a.as_slice() {
            [] => 0.0,
            [one] => js_number(Some(one)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'-' => (-1.0, &t[1..]),
        b'+' => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return u64::from_str_radix(rest, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    let ok = !body.is_empty()
        && body.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'))
        && body.bytes().any(|c| c.is_ascii_digit());
    if !ok {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |n| sign * n)
}

/// A finite number as a JSON value: an integer when it is one, otherwise a float.
pub fn num_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

const B64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// `btoa` over bytes: standard alphabet with `=` padding.
pub fn to_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `atob`: ASCII whitespace is ignored and padding is optional.
pub fn from_base64(text: &str) -> Option<Vec<u8>> {
    let clean: String = text.chars().filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r')).collect();
    B64.decode(clean.as_bytes()).ok()
}

/// `Math.round`: halves go toward +infinity.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `^[A-Za-z0-9_-]{1,64}$`
pub fn is_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// `^[0-9a-f]{n}$`
pub fn is_lower_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// JSON text from the network may carry lone surrogate escapes (`\ud83d`), which JavaScript
/// accepts and a Rust `String` cannot hold. Replace each with U+FFFD before parsing.
pub fn sanitize_lone_surrogates(json: &str) -> std::borrow::Cow<'_, str> {
    if !json.contains("\\u") {
        return json.into();
    }
    let b = json.as_bytes();
    let hex4 = |i: usize| -> Option<u32> {
        let s = json.get(i..i + 4)?;
        if s.bytes().all(|c| c.is_ascii_hexdigit()) {
            u32::from_str_radix(s, 16).ok()
        } else {
            None
        }
    };
    let mut out = String::with_capacity(json.len());
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        if b.get(i + 1) == Some(&b'u') {
            if let Some(u) = hex4(i + 2) {
                if (0xD800..0xDC00).contains(&u) {
                    let low = (b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u'))
                        .then(|| hex4(i + 8))
                        .flatten()
                        .filter(|l| (0xDC00..0xE000).contains(l));
                    if low.is_some() {
                        i += 12;
                        continue;
                    }
                    out.push_str(&json[last..i]);
                    out.push_str("\\ufffd");
                    i += 6;
                    last = i;
                    continue;
                } else if (0xDC00..0xE000).contains(&u) {
                    out.push_str(&json[last..i]);
                    out.push_str("\\ufffd");
                    i += 6;
                    last = i;
                    continue;
                }
                i += 6;
                continue;
            }
        }
        i += 2;
    }
    out.push_str(&json[last..]);
    out.into()
}

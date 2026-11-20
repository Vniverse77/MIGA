//! QR codes drawn with Unicode half blocks (two modules per character cell).
use qrcode::{Color, EcLevel, QrCode};

/// The code as text lines, dark modules as blocks on the terminal's own background inverted so it
/// scans from both dark and light themes: the code is drawn light-on-dark inside a light quiet zone.
pub fn lines(text: &str) -> Option<Vec<String>> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M).ok()?;
    let width = code.width();
    let quiet = 2usize;
    let side = width + quiet * 2;
    let dark = |x: usize, y: usize| {
        x >= quiet
            && y >= quiet
            && x < quiet + width
            && y < quiet + width
            && code[(x - quiet, y - quiet)] == Color::Dark
    };
    // Black modules on a white field: a full block is white, so we print white where the module is light.
    let mut out = Vec::new();
    let mut y = 0;
    while y < side {
        let mut line = String::new();
        for x in 0..side {
            let (top, bottom) = (!dark(x, y), y + 1 >= side || !dark(x, y + 1));
            line.push(match (top, bottom) {
                (true, true) => '\u{2588}',
                (true, false) => '\u{2580}',
                (false, true) => '\u{2584}',
                (false, false) => ' ',
            });
        }
        out.push(line);
        y += 2;
    }
    Some(out)
}

/// The origin of the web app that belongs to a relay URL (`wss://host/ws` -> `https://host`).
pub fn app_origin(relay: &str) -> String {
    let rest =
        relay.strip_prefix("wss://").map(|r| ("https", r)).or_else(|| relay.strip_prefix("ws://").map(|r| ("http", r)));
    match rest {
        Some((scheme, r)) => format!("{scheme}://{}", r.split('/').next().unwrap_or_default()),
        None => "https://miga.vniverse77.com".into(),
    }
}

pub fn link_url(relay: &str, code: &str) -> String {
    format!("{}/app/#link={code}", app_origin(relay))
}

//! Semantic colour roles with truecolor, 256-colour, 16-colour and monochrome renderings.
use super::config::ThemeConfig;
use ratatui::style::{Color, Modifier, Style};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    True,
    Indexed,
    Ansi16,
    Mono,
}

impl ColorMode {
    /// `NO_COLOR` wins, then the config, then `COLORTERM` and `TERM`.
    pub fn detect(setting: &str) -> ColorMode {
        if std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) {
            return ColorMode::Mono;
        }
        match setting {
            "truecolor" | "24bit" => return ColorMode::True,
            "256" => return ColorMode::Indexed,
            "16" => return ColorMode::Ansi16,
            "none" | "mono" => return ColorMode::Mono,
            _ => {}
        }
        let env = |k: &str| std::env::var(k).unwrap_or_default().to_lowercase();
        if matches!(env("COLORTERM").as_str(), "truecolor" | "24bit") {
            ColorMode::True
        } else if env("TERM").contains("256color") {
            ColorMode::Indexed
        } else if env("TERM") == "dumb" {
            ColorMode::Mono
        } else {
            ColorMode::Ansi16
        }
    }
}

/// One role, written once as RGB (the web app's tokens) plus its 16-colour stand-in.
#[derive(Clone, Copy)]
struct Role {
    rgb: (u8, u8, u8),
    ansi: Color,
}

fn role(hex: u32, ansi: Color) -> Role {
    Role { rgb: ((hex >> 16) as u8, (hex >> 8) as u8, hex as u8), ansi }
}

fn parse_hex(s: &str) -> Option<u32> {
    let s = s.trim().trim_start_matches('#');
    (s.len() == 6).then(|| u32::from_str_radix(s, 16).ok()).flatten()
}

#[derive(Debug, Clone)]
pub struct Theme {
    pub mode: ColorMode,
    /// True when messages sit on filled backgrounds (truecolor and 256 colours).
    pub fills: bool,
    pub bg: Color,
    pub card: Color,
    pub bubble_in: Color,
    pub bubble_out: Color,
    pub select: Color,
    pub primary: Color,
    pub secondary: Color,
    pub muted: Color,
    pub text: Color,
    pub on_primary: Color,
    pub on_primary_dim: Color,
    pub read: Color,
    pub error: Color,
    pub warn: Color,
    pub ok: Color,
}

impl Theme {
    pub fn new(mode: ColorMode, cfg: &ThemeConfig) -> Theme {
        let pick = |custom: &Option<String>, default: u32| custom.as_deref().and_then(parse_hex).unwrap_or(default);
        let transparent = cfg.name == "transparent";
        let mono = mode == ColorMode::Mono || cfg.name == "mono";
        let mode = if mono { ColorMode::Mono } else { mode };
        let conv = |r: Role| -> Color {
            match mode {
                ColorMode::True => Color::Rgb(r.rgb.0, r.rgb.1, r.rgb.2),
                ColorMode::Indexed => Color::Indexed(nearest_256(r.rgb)),
                ColorMode::Ansi16 => r.ansi,
                ColorMode::Mono => Color::Reset,
            }
        };
        let fills = matches!(mode, ColorMode::True | ColorMode::Indexed);
        let bg = if transparent || !fills { Color::Reset } else { conv(role(pick(&cfg.bg, 0x070b14), Color::Black)) };
        let card = if fills { conv(role(pick(&cfg.card, 0x0d1525), Color::Black)) } else { Color::Reset };
        Theme {
            mode,
            fills,
            bg,
            card,
            bubble_in: conv(role(0x15203a, Color::Black)),
            bubble_out: conv(role(pick(&cfg.primary, 0x1a6bbf), Color::Blue)),
            select: conv(role(0x1d3158, Color::Black)),
            primary: conv(role(pick(&cfg.primary, 0x1a6bbf), Color::Blue)),
            secondary: conv(role(pick(&cfg.secondary, 0x378add), Color::LightBlue)),
            muted: conv(role(pick(&cfg.muted, 0x4a7ab5), Color::Gray)),
            text: conv(role(pick(&cfg.text, 0xc8d8f0), Color::White)),
            on_primary: conv(role(0xf2f7ff, Color::White)),
            on_primary_dim: conv(role(0xb4d0f0, Color::Gray)),
            read: conv(role(0x8fd4ff, Color::LightCyan)),
            error: conv(role(0xe5707e, Color::Red)),
            warn: conv(role(0xe0b45a, Color::Yellow)),
            ok: conv(role(0x5ec4a0, Color::Green)),
        }
    }

    pub fn mono(&self) -> bool {
        self.mode == ColorMode::Mono
    }

    pub fn base(&self) -> Style {
        Style::default().fg(self.text).bg(self.bg)
    }
    pub fn on_card(&self) -> Style {
        Style::default().fg(self.text).bg(self.card)
    }
    pub fn dim(&self, bg: Color) -> Style {
        let s = Style::default().fg(self.muted).bg(bg);
        if self.mono() {
            s.add_modifier(Modifier::DIM)
        } else {
            s
        }
    }
    pub fn accent(&self, bg: Color) -> Style {
        Style::default().fg(self.secondary).bg(bg)
    }
    pub fn bold(&self, bg: Color) -> Style {
        Style::default().fg(self.text).bg(bg).add_modifier(Modifier::BOLD)
    }
}

/// Nearest xterm-256 index (colour cube and grey ramp).
pub fn nearest_256((r, g, b): (u8, u8, u8)) -> u8 {
    const STEPS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    let near = |v: u8| {
        STEPS.iter().enumerate().min_by_key(|(_, s)| i32::from(v).abs_diff(i32::from(**s))).map_or(0, |(i, _)| i)
    };
    let (ri, gi, bi) = (near(r), near(g), near(b));
    let cube = (STEPS[ri], STEPS[gi], STEPS[bi]);
    let cube_idx = 16 + 36 * ri + 6 * gi + bi;
    let avg = (u32::from(r) + u32::from(g) + u32::from(b)) / 3;
    let grey_i = ((avg.saturating_sub(8)) / 10).min(23);
    let grey = (8 + 10 * grey_i) as u8;
    let dist = |c: (u8, u8, u8)| {
        let d = |a: u8, b: u8| i32::from(a).abs_diff(i32::from(b)).pow(2);
        d(c.0, r) + d(c.1, g) + d(c.2, b)
    };
    if dist((grey, grey, grey)) < dist(cube) {
        (232 + grey_i) as u8
    } else {
        cube_idx as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_matches_the_plan_table() {
        assert_eq!(nearest_256((0x1a, 0x6b, 0xbf)), 25);
        assert_eq!(nearest_256((0x37, 0x8a, 0xdd)), 68);
        assert_eq!(nearest_256((0x4a, 0x7a, 0xb5)), 67);
        assert!((232..=235).contains(&nearest_256((0x07, 0x0b, 0x14))));
    }

    #[test]
    fn mode_from_setting() {
        assert_eq!(ColorMode::detect("256"), ColorMode::Indexed);
        assert_eq!(ColorMode::detect("16"), ColorMode::Ansi16);
        assert_eq!(ColorMode::detect("truecolor"), ColorMode::True);
    }

    #[test]
    fn sixteen_colours_do_not_fill() {
        let t = Theme::new(ColorMode::Ansi16, &ThemeConfig::default());
        assert!(!t.fills && t.bg == Color::Reset);
    }
}

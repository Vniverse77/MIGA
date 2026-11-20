//! Guided first run inside the terminal UI: create a new address or link this device to an account
//! that already exists (typing the code shown by the app).
use super::composer::Composer;
use super::text::{truncate, width};
use super::theme::Theme;
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Choice { sel: usize },
    Name(Composer),
    Code(Composer),
    Working(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Do {
    Nothing,
    Create(String),
    Join(String),
    Quit,
}

#[derive(Debug, Clone)]
pub struct First {
    pub step: Step,
    pub error: Option<String>,
}

impl Default for First {
    fn default() -> Self {
        First { step: Step::Choice { sel: 0 }, error: None }
    }
}

impl First {
    pub fn handle_key(&mut self, key: KeyEvent) -> Do {
        if key.kind == KeyEventKind::Release {
            return Do::Nothing;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c' | 'q')) {
            return Do::Quit;
        }
        let step = std::mem::replace(&mut self.step, Step::Working(String::new()));
        match step {
            Step::Choice { mut sel } => {
                match key.code {
                    KeyCode::Up | KeyCode::Char('k') => sel = 0,
                    KeyCode::Down | KeyCode::Char('j') => sel = 1,
                    KeyCode::Char('1' | 'c') => sel = 0,
                    KeyCode::Char('2' | 'l') => sel = 1,
                    KeyCode::Char('q') | KeyCode::Esc => return Do::Quit,
                    KeyCode::Enter => {
                        self.error = None;
                        self.step =
                            if sel == 0 { Step::Name(Composer::default()) } else { Step::Code(Composer::default()) };
                        return Do::Nothing;
                    }
                    _ => {}
                }
                self.step = Step::Choice { sel };
                Do::Nothing
            }
            Step::Name(mut c) => match key.code {
                KeyCode::Esc => {
                    self.step = Step::Choice { sel: 0 };
                    Do::Nothing
                }
                KeyCode::Enter => {
                    let name = c.text().trim().to_string();
                    self.step = Step::Working("Creating your address...".into());
                    Do::Create(name)
                }
                _ => {
                    c.handle_key(&key, 40);
                    self.step = Step::Name(c);
                    Do::Nothing
                }
            },
            Step::Code(mut c) => match key.code {
                KeyCode::Esc => {
                    self.step = Step::Choice { sel: 1 };
                    Do::Nothing
                }
                KeyCode::Enter => match miga_core::link::normalize_link_code(c.text()) {
                    Some(code) => {
                        self.error = None;
                        self.step = Step::Working("Looking for the link on the relay...".into());
                        Do::Join(code)
                    }
                    None => {
                        self.error = Some("That is not a valid code (12 characters, like G857-6A7E-NR5M)".into());
                        self.step = Step::Code(c);
                        Do::Nothing
                    }
                },
                _ => {
                    c.handle_key(&key, 24);
                    self.error = None;
                    self.step = Step::Code(c);
                    Do::Nothing
                }
            },
            Step::Working(m) => {
                self.step = Step::Working(m);
                Do::Nothing
            }
        }
    }

    pub fn paste(&mut self, text: &str) {
        match &mut self.step {
            Step::Name(c) | Step::Code(c) => c.insert(&text.split_whitespace().collect::<Vec<_>>().join(" ")),
            _ => {}
        }
    }
}

pub fn draw(f: &mut Frame, first: &First, theme: &Theme) {
    let area = f.area();
    f.render_widget(Block::default().style(theme.base()), area);
    let w = 64.min(area.width);
    let h = 15.min(area.height);
    let r =
        Rect { x: area.x + (area.width - w) / 2, y: area.y + (area.height.saturating_sub(h)) / 3, width: w, height: h };
    f.render_widget(Clear, r);
    let t = theme;
    let key = |k: &str| Span::styled(k.to_string(), t.accent(t.card).add_modifier(Modifier::BOLD));
    let dim = |s: &str| Span::styled(s.to_string(), t.dim(t.card));
    let mut lines = vec![Line::from("")];
    let mut cursor = None;
    match &first.step {
        Step::Choice { sel } => {
            lines.push(Line::from(Span::styled("  Private messages, end to end encrypted.", t.on_card())));
            lines.push(Line::from(dim("  No account, no phone number: an address is a key.")));
            lines.push(Line::from(""));
            for (i, (k, label)) in
                [("1", "Create a new address"), ("2", "Link to an account I already use")].iter().enumerate()
            {
                let on = i == *sel;
                let style = if on { t.accent(t.card).add_modifier(Modifier::REVERSED) } else { t.on_card() };
                lines.push(Line::from(vec![Span::styled(format!("  {k}  {label:<40}"), style)]));
            }
            lines.push(Line::from(""));
            lines.push(Line::from(dim("  Linking copies your contacts and history from your phone or")));
            lines.push(Line::from(dim("  browser: open Settings, Devices, Add a device there.")));
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  ", t.on_card()),
                key("Enter"),
                dim(" choose   "),
                key("Ctrl+C"),
                dim(" quit"),
            ]));
        }
        Step::Name(c) => {
            lines.push(Line::from(Span::styled("  Your display name (optional)", t.bold(t.card))));
            lines.push(Line::from(dim("  Shared with the people you write to. Leave empty to stay anonymous.")));
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  > ", t.accent(t.card)),
                Span::styled(c.text().to_string(), t.on_card()),
            ]));
            cursor = Some((r.x + 5 + width(c.text()) as u16, r.y + 4));
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  ", t.on_card()),
                key("Enter"),
                dim(" create   "),
                key("Esc"),
                dim(" back"),
            ]));
        }
        Step::Code(c) => {
            lines.push(Line::from(Span::styled("  Link code", t.bold(t.card))));
            lines.push(Line::from(dim("  On your other device: Settings, Devices, Add a device.")));
            lines.push(Line::from(dim("  Type the 12-character code it shows (valid 10 minutes).")));
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  > ", t.accent(t.card)),
                Span::styled(c.text().to_string(), t.on_card()),
            ]));
            cursor = Some((r.x + 5 + width(c.text()) as u16, r.y + 5));
            if let Some(e) = &first.error {
                lines.push(Line::from(Span::styled(
                    format!("  {}", truncate(e, usize::from(w) - 6)),
                    Style::default().fg(t.error).bg(t.card),
                )));
            } else {
                lines.push(Line::from(""));
            }
            lines.push(Line::from(vec![
                Span::styled("  ", t.on_card()),
                key("Enter"),
                dim(" link   "),
                key("Esc"),
                dim(" back"),
            ]));
        }
        Step::Working(m) => {
            lines.push(Line::from(Span::styled(format!("  {m}"), t.on_card())));
            lines.push(Line::from(dim("  Linking derives a key (a few seconds) and waits for the other device.")));
        }
    }
    if let (Step::Choice { .. } | Step::Name(_), Some(e)) = (&first.step, &first.error) {
        lines.push(Line::from(Span::styled(
            format!("  {}", truncate(e, usize::from(w) - 6)),
            Style::default().fg(t.error).bg(t.card),
        )));
    }
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(t.secondary).bg(t.card))
        .title(Span::styled(" Welcome to MIGA ", Style::default().fg(t.text).bg(t.card).add_modifier(Modifier::BOLD)))
        .style(t.on_card());
    f.render_widget(Paragraph::new(lines).block(block), r);
    if let Some((x, y)) = cursor {
        f.set_cursor_position(ratatui::layout::Position::new(x, y));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn text(first: &First) -> String {
        let cfg = super::super::config::Config::default();
        let theme = Theme::new(super::super::theme::ColorMode::True, &cfg.theme);
        let mut term = Terminal::new(TestBackend::new(80, 20)).unwrap();
        term.draw(|f| draw(f, first, &theme)).unwrap();
        let buf = term.backend().buffer().clone();
        (0..20)
            .map(|y| (0..80).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>().trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn choice_then_create_asks_for_a_name() {
        let mut f = First::default();
        let screen = text(&f);
        assert!(screen.contains("Create a new address") && screen.contains("Link to an account"), "{screen}");
        assert_eq!(f.handle_key(KeyEvent::from(KeyCode::Enter)), Do::Nothing);
        assert!(matches!(f.step, Step::Name(_)));
        for c in "Mira".chars() {
            f.handle_key(KeyEvent::from(KeyCode::Char(c)));
        }
        assert_eq!(f.handle_key(KeyEvent::from(KeyCode::Enter)), Do::Create("Mira".into()));
    }

    #[test]
    fn link_validates_the_code() {
        let mut f = First::default();
        f.handle_key(KeyEvent::from(KeyCode::Char('2')));
        f.handle_key(KeyEvent::from(KeyCode::Enter));
        for c in "abc".chars() {
            f.handle_key(KeyEvent::from(KeyCode::Char(c)));
        }
        assert_eq!(f.handle_key(KeyEvent::from(KeyCode::Enter)), Do::Nothing);
        assert!(text(&f).contains("not a valid code"));
        let mut f = First { step: Step::Code(Composer::default()), error: None };
        for c in "g857-6a7e-nr5m".chars() {
            f.handle_key(KeyEvent::from(KeyCode::Char(c)));
        }
        assert_eq!(f.handle_key(KeyEvent::from(KeyCode::Enter)), Do::Join("G857-6A7E-NR5M".replace('-', "")));
    }
}

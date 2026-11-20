//! The message composer: UTF-8 aware multi-line text with a byte cursor. One place, no widget crate.
use super::text::{width, wrap_ranges};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Composer {
    text: String,
    cursor: usize,
}

impl Composer {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn set(&mut self, text: &str) {
        self.text = text.to_string();
        self.cursor = self.text.len();
    }

    pub fn take(&mut self) -> String {
        self.cursor = 0;
        std::mem::take(&mut self.text)
    }

    pub fn insert(&mut self, s: &str) {
        let clean: String = s
            .chars()
            .filter_map(|c| match c {
                '\r' => None,
                '\n' => Some('\n'),
                '\t' => Some(' '),
                c if c.is_control() => None,
                c => Some(c),
            })
            .collect();
        self.text.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
    }

    fn prev_boundary(&self, at: usize) -> usize {
        self.text[..at].grapheme_indices(true).next_back().map_or(0, |(i, _)| i)
    }

    fn next_boundary(&self, at: usize) -> usize {
        self.text[at..].grapheme_indices(true).nth(1).map_or(self.text.len(), |(i, _)| at + i)
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let p = self.prev_boundary(self.cursor);
            self.text.replace_range(p..self.cursor, "");
            self.cursor = p;
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.text.len() {
            let n = self.next_boundary(self.cursor);
            self.text.replace_range(self.cursor..n, "");
        }
    }

    pub fn left(&mut self) {
        self.cursor = self.prev_boundary(self.cursor);
    }

    pub fn right(&mut self) {
        if self.cursor < self.text.len() {
            self.cursor = self.next_boundary(self.cursor);
        }
    }

    fn line_bounds(&self) -> (usize, usize) {
        let start = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
        let end = self.text[self.cursor..].find('\n').map_or(self.text.len(), |i| self.cursor + i);
        (start, end)
    }

    pub fn home(&mut self) {
        self.cursor = self.line_bounds().0;
    }

    pub fn end(&mut self) {
        self.cursor = self.line_bounds().1;
    }

    pub fn word_left(&mut self) {
        let before = &self.text[..self.cursor];
        let trimmed = before.trim_end();
        self.cursor =
            trimmed.rfind(char::is_whitespace).map_or(0, |i| i + trimmed[i..].chars().next().map_or(1, char::len_utf8));
    }

    pub fn word_right(&mut self) {
        let rest = &self.text[self.cursor..];
        let skip = rest.len() - rest.trim_start().len();
        let after = &rest[skip..];
        let word = after.find(char::is_whitespace).unwrap_or(after.len());
        self.cursor += skip + word;
    }

    pub fn delete_word_back(&mut self) {
        let end = self.cursor;
        self.word_left();
        self.text.replace_range(self.cursor..end, "");
    }

    pub fn delete_to_line_start(&mut self) {
        let (start, _) = self.line_bounds();
        self.text.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    /// Display lines at `max` columns and the cursor as (row, column).
    pub fn layout(&self, max: usize) -> (Vec<(usize, usize)>, (usize, usize)) {
        let ranges = wrap_ranges(&self.text, max);
        let mut at = ranges.len() - 1;
        for (i, (s, e)) in ranges.iter().enumerate() {
            let soft_next = ranges.get(i + 1).is_some_and(|n| n.0 == *e);
            if self.cursor >= *s && (self.cursor < *e || (self.cursor == *e && !soft_next)) {
                at = i;
                break;
            }
        }
        let col = width(&self.text[ranges[at].0..self.cursor.min(ranges[at].1).max(ranges[at].0)]);
        (ranges, (at, col))
    }

    fn vertical(&mut self, max: usize, down: bool) -> bool {
        let (ranges, (row, col)) = self.layout(max);
        let target = if down {
            if row + 1 >= ranges.len() {
                return false;
            }
            row + 1
        } else {
            if row == 0 {
                return false;
            }
            row - 1
        };
        let (s, e) = ranges[target];
        let mut w = 0;
        let mut pos = s;
        for (i, g) in self.text[s..e].grapheme_indices(true) {
            if w >= col {
                break;
            }
            w += width(g);
            pos = s + i + g.len();
        }
        if col == 0 {
            pos = s;
        }
        self.cursor = pos.min(e);
        true
    }

    /// Handles an editing key. `max` is the text width in columns. Returns true if the key was used.
    pub fn handle_key(&mut self, key: &KeyEvent, max: usize) -> bool {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        match key.code {
            KeyCode::Char(c) if ctrl => match c.to_ascii_lowercase() {
                'a' => self.home(),
                'e' => self.end(),
                'w' => self.delete_word_back(),
                'u' => self.delete_to_line_start(),
                'b' => self.left(),
                'f' => self.right(),
                'd' => self.delete(),
                'h' => self.backspace(),
                _ => return false,
            },
            KeyCode::Char(c) if alt => match c.to_ascii_lowercase() {
                'b' => self.word_left(),
                'f' => self.word_right(),
                _ => return false,
            },
            KeyCode::Char(c) => {
                let mut buf = [0u8; 4];
                self.insert(c.encode_utf8(&mut buf));
            }
            KeyCode::Backspace if alt => self.delete_word_back(),
            KeyCode::Backspace => self.backspace(),
            KeyCode::Delete => self.delete(),
            KeyCode::Left if ctrl || alt => self.word_left(),
            KeyCode::Right if ctrl || alt => self.word_right(),
            KeyCode::Left => self.left(),
            KeyCode::Right => self.right(),
            KeyCode::Home => self.home(),
            KeyCode::End => self.end(),
            KeyCode::Up => return self.vertical(max, false),
            KeyCode::Down => return self.vertical(max, true),
            _ => return false,
        }
        true
    }

    pub fn newline(&mut self) {
        self.insert("\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(c: KeyCode) -> KeyEvent {
        KeyEvent::new(c, KeyModifiers::NONE)
    }

    #[test]
    fn typing_and_backspace_respect_graphemes() {
        let mut c = Composer::default();
        c.insert("a\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}b");
        c.left();
        c.backspace();
        assert_eq!(c.text(), "ab");
        c.insert("\u{e9}");
        assert_eq!(c.text(), "a\u{e9}b");
    }

    #[test]
    fn newline_and_vertical_movement() {
        let mut c = Composer::default();
        c.insert("hello");
        c.newline();
        c.insert("wide world");
        assert!(c.handle_key(&key(KeyCode::Up), 40));
        assert!(c.text().is_char_boundary(c.cursor));
        let (_, (row, _)) = c.layout(40);
        assert_eq!(row, 0);
        assert!(!c.handle_key(&key(KeyCode::Up), 40));
    }

    #[test]
    fn word_and_line_kills() {
        let mut c = Composer::default();
        c.insert("one two three");
        c.delete_word_back();
        assert_eq!(c.text(), "one two ");
        c.word_left();
        c.insert("X");
        assert_eq!(c.text(), "one Xtwo ");
        c.delete_to_line_start();
        assert_eq!(c.text(), "two ");
    }

    #[test]
    fn paste_strips_controls() {
        let mut c = Composer::default();
        c.insert("a\x1b[2Jb\r\nc");
        assert_eq!(c.text(), "a[2Jb\nc");
    }

    #[test]
    fn cursor_follows_soft_wrap() {
        let mut c = Composer::default();
        c.insert("aaaa bbbb");
        let (lines, (row, col)) = c.layout(6);
        assert_eq!(lines.len(), 2);
        assert_eq!((row, col), (1, 4));
    }
}

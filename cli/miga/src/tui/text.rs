//! Text helpers: sanitising, width-aware wrapping and truncation, fuzzy matching, links.
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Removes control characters and bidi overrides so received text cannot drive the terminal.
pub fn sanitize(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '\n' => Some('\n'),
            '\t' => Some(' '),
            '\r' => None,
            c if c.is_control() => None,
            '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' => None,
            c => Some(c),
        })
        .collect()
}

pub fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

/// Cuts `s` to at most `max` columns, ending with an ellipsis when something was removed.
pub fn truncate(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut w = 0;
    for g in s.graphemes(true) {
        let gw = width(g);
        if w + gw + 1 > max {
            break;
        }
        out.push_str(g);
        w += gw;
    }
    out.push('\u{2026}');
    out
}

/// First line of `s`, collapsed whitespace.
pub fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pads `s` with spaces on the right up to `w` columns.
pub fn pad_right(s: &str, w: usize) -> String {
    let cur = width(s);
    format!("{s}{}", " ".repeat(w.saturating_sub(cur)))
}

/// Byte ranges of the visual lines of `text` at `max` columns. Soft wraps are contiguous
/// (`end == next.start`); a hard newline leaves its `\n` byte out between two ranges.
pub fn wrap_ranges(text: &str, max: usize) -> Vec<(usize, usize)> {
    let max = max.max(1);
    let mut out = Vec::new();
    let mut para_start = 0;
    loop {
        let para_end = text[para_start..].find('\n').map_or(text.len(), |i| para_start + i);
        wrap_paragraph(text, para_start, para_end, max, &mut out);
        if para_end >= text.len() {
            break;
        }
        para_start = para_end + 1;
    }
    out
}

fn wrap_paragraph(text: &str, start: usize, end: usize, max: usize, out: &mut Vec<(usize, usize)>) {
    let gs: Vec<(usize, &str, usize)> =
        text[start..end].grapheme_indices(true).map(|(i, g)| (start + i, g, width(g))).collect();
    let mut line_start = 0; // index into gs
    let mut w = 0;
    let mut brk: Option<usize> = None; // first grapheme after the last space of this line
    for i in 0..gs.len() {
        let (_, g, gw) = gs[i];
        if w + gw > max && w > 0 && g != " " {
            let cut = brk.filter(|b| *b > line_start).unwrap_or(i);
            out.push((gs[line_start].0, gs[cut].0));
            line_start = cut;
            w = gs[cut..i].iter().map(|x| x.2).sum();
            brk = None;
        }
        w += gw;
        if g == " " {
            brk = Some(i + 1);
        }
    }
    out.push((gs.get(line_start).map_or(start, |x| x.0), end));
}

/// Wraps `text` into display lines (trailing spaces trimmed).
pub fn wrap(text: &str, max: usize) -> Vec<String> {
    wrap_ranges(text, max).into_iter().map(|(a, b)| text[a..b].trim_end().to_string()).collect()
}

/// Fuzzy subsequence score (higher is better); `None` when the query does not match.
pub fn fuzzy(query: &str, candidate: &str) -> Option<i32> {
    let q: Vec<char> = query.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    if q.is_empty() {
        return Some(0);
    }
    let cand: Vec<char> = candidate.to_lowercase().chars().collect();
    let mut qi = 0;
    let mut score = 0;
    let mut prev: Option<usize> = None;
    for (i, c) in cand.iter().enumerate() {
        if qi < q.len() && *c == q[qi] {
            score += 10;
            if prev == Some(i.wrapping_sub(1)) {
                score += 15;
            }
            if i == 0 || !cand[i - 1].is_alphanumeric() {
                score += 12;
            }
            prev = Some(i);
            qi += 1;
        }
    }
    (qi == q.len()).then(|| score - cand.len() as i32 / 4)
}

/// `http(s)://` links in a text.
pub fn links(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.trim_start_matches(['(', '<', '"', '\'']))
        .filter(|w| w.starts_with("http://") || w.starts_with("https://"))
        .map(|w| w.trim_end_matches(['.', ',', ')', ';', '!', '?', '"', '\'']).to_string())
        .filter(|w| w.len() > 8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_drops_escapes() {
        assert_eq!(sanitize("a\x1b[31mb\u{202e}c\r\nd\te"), "a[31mbc\nd e");
    }

    #[test]
    fn wrap_breaks_at_spaces_and_hard() {
        assert_eq!(wrap("hello brave new world", 11), vec!["hello brave", "new world"]);
        assert_eq!(wrap("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
        assert_eq!(wrap("a\n\nb", 5), vec!["a", "", "b"]);
    }

    #[test]
    fn wrap_counts_wide_characters() {
        let lines = wrap("\u{1F600}\u{1F600}\u{1F600}", 4);
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| width(l) <= 4));
    }

    #[test]
    fn truncate_uses_columns() {
        assert_eq!(truncate("hello world", 8), "hello w\u{2026}");
        assert_eq!(truncate("hi", 8), "hi");
        assert!(width(&truncate("\u{1F600}\u{1F600}\u{1F600}", 5)) <= 5);
    }

    #[test]
    fn fuzzy_prefers_prefix_and_rejects_non_subsequences() {
        assert!(fuzzy("ayl", "Aylar").unwrap() > fuzzy("ayl", "Bayline x").unwrap());
        assert!(fuzzy("zzz", "Aylar").is_none());
        assert_eq!(fuzzy("", "x"), Some(0));
    }

    #[test]
    fn finds_links() {
        assert_eq!(
            links("see https://example.org/a, and (http://x.test/b)."),
            vec!["https://example.org/a", "http://x.test/b"]
        );
    }
}

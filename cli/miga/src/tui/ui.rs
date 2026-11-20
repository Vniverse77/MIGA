//! Drawing. Pure function of [`App`] (plus the layout values it records for the mouse).
use super::app::{App, Conn, Delivery, Focus, Msg, Popup, Row, State};
use super::keys::{describe, Action};
use super::text::{pad_right, truncate, width, wrap};
use ratatui::layout::{Alignment, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::border;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

const MAX_COMPOSER_LINES: usize = 6;

pub fn short_addr(a: &str) -> String {
    if a.len() > 12 {
        format!("{}\u{2026}{}", &a[..4], &a[a.len() - 4..])
    } else {
        a.to_string()
    }
}

fn zoned(app: &App, ms: f64) -> Option<jiff::Zoned> {
    jiff::Timestamp::from_millisecond(ms as i64).ok().map(|t| t.to_zoned(app.tz.clone()))
}

fn clock(app: &App, ms: f64) -> String {
    zoned(app, ms).map_or_else(|| "--:--".into(), |z| z.strftime("%H:%M").to_string())
}

fn day_label(app: &App, ms: f64) -> String {
    let (Some(z), Some(now)) = (zoned(app, ms), zoned(app, app.now)) else { return String::new() };
    let (d, today) = (z.date(), now.date());
    if d == today {
        "Today".into()
    } else if today.yesterday().ok() == Some(d) {
        "Yesterday".into()
    } else if d.year() == today.year() {
        z.strftime("%b %-d").to_string()
    } else {
        z.strftime("%b %-d, %Y").to_string()
    }
}

/// Time for the chat list: clock today, then "Yest", then the date.
fn list_time(app: &App, ms: f64) -> String {
    if ms <= 0.0 {
        return String::new();
    }
    match day_label(app, ms).as_str() {
        "Today" => clock(app, ms),
        "Yesterday" => "Yest".into(),
        other => other.to_string(),
    }
}

fn day_of(app: &App, ms: f64) -> Option<jiff::civil::Date> {
    zoned(app, ms).map(|z| z.date())
}

fn glyph<'a>(app: &App, fancy: &'a str, plain: &'a str) -> &'a str {
    if app.cfg.ascii_borders {
        plain
    } else {
        fancy
    }
}

fn border_set(app: &App) -> border::Set<'static> {
    if app.cfg.ascii_borders {
        border::Set {
            top_left: "+",
            top_right: "+",
            bottom_left: "+",
            bottom_right: "+",
            vertical_left: "|",
            vertical_right: "|",
            horizontal_top: "-",
            horizontal_bottom: "-",
        }
    } else {
        border::ROUNDED
    }
}

pub struct Areas {
    pub header: Rect,
    pub list: Option<Rect>,
    pub conv: Option<Rect>,
    pub footer: Rect,
}

pub fn areas(app: &App, area: Rect) -> Areas {
    let header = Rect { height: 1.min(area.height), ..area };
    let footer = Rect { y: area.y + area.height.saturating_sub(1), height: 1.min(area.height), ..area };
    let body = Rect { y: area.y + 1, height: area.height.saturating_sub(2), ..area };
    if app.narrow() {
        if app.focus == Focus::List {
            Areas { header, list: Some(body), conv: None, footer }
        } else {
            Areas { header, list: None, conv: Some(body), footer }
        }
    } else {
        let lw = app.cfg.sidebar_width.clamp(18, (area.width * 2 / 5).max(18)).min(area.width.saturating_sub(10));
        let list = Rect { width: lw, ..body };
        let conv = Rect { x: body.x + lw, width: body.width - lw, ..body };
        Areas { header, list: Some(list), conv: Some(conv), footer }
    }
}

pub fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    app.size = (area.width, area.height);
    f.render_widget(Block::default().style(app.theme.base()), area);
    if area.width < 24 || area.height < 8 {
        f.render_widget(Paragraph::new("Terminal too small").style(app.theme.base()), area);
        return;
    }
    let a = areas(app, area);
    app.hit = Default::default();
    draw_header(f, app, &a);
    if let Some(r) = a.list {
        draw_list(f, app, r);
    }
    if let Some(r) = a.conv {
        draw_conversation(f, app, r);
    }
    draw_footer(f, app, a.footer);
    draw_popup(f, app, area, a.footer);
}

// ---- header and footer ---------------------------------------------------------------------

fn conn_span(app: &App) -> Span<'static> {
    let t = &app.theme;
    if let Some((done, total)) = app.history {
        let pct = (done * 100).checked_div(total).unwrap_or(0).min(if done >= total { 100 } else { 99 });
        return Span::styled(
            format!("{} history {pct}%", glyph(app, "\u{25cf}", "*")),
            Style::default().fg(t.warn).bg(t.card),
        );
    }
    let (txt, color) = match app.conn {
        Conn::Online => ("online", t.ok),
        Conn::Connecting => ("connecting", t.warn),
        Conn::Offline => ("offline", t.error),
    };
    Span::styled(format!("{} {txt}", glyph(app, "\u{25cf}", "*")), Style::default().fg(color).bg(t.card))
}

fn draw_header(f: &mut Frame, app: &App, a: &Areas) {
    let t = &app.theme;
    f.render_widget(Block::default().style(t.on_card()), a.header);
    let list_w = a.list.map_or(0, |l| l.width);
    let show_brand = a.list.is_some();
    if show_brand {
        let w = if a.conv.is_some() { list_w } else { a.header.width };
        let brand = Span::styled(" MIGA", Style::default().fg(t.secondary).bg(t.card).add_modifier(Modifier::BOLD));
        let conn = conn_span(app);
        let gap = usize::from(w).saturating_sub(5 + 1 + width(&conn.content));
        let line =
            Line::from(vec![brand, Span::styled(" ".repeat(gap), t.on_card()), conn, Span::styled(" ", t.on_card())]);
        f.render_widget(Paragraph::new(line), Rect { width: w, ..a.header });
    }
    if let (Some(conv), Some(chat)) = (a.conv, app.chat()) {
        let back = if a.list.is_none() { format!("{} ", glyph(app, "\u{2039}", "<")) } else { String::new() };
        let mut spans = vec![
            Span::styled(format!(" {back}"), t.accent(t.card)),
            Span::styled(truncate(&chat.name, 30), t.bold(t.card)),
            Span::styled(format!("  {}", short_addr(&chat.address)), t.dim(t.card)),
        ];
        let mut marks = Vec::new();
        if app.verified.contains(&chat.address) {
            marks.push("verified");
        }
        if app.is_muted(&chat.address) {
            marks.push("muted");
        }
        if app.is_blocked(&chat.address) {
            marks.push("blocked");
        }
        if !marks.is_empty() {
            spans.push(Span::styled(format!("  [{}]", marks.join(", ")), t.dim(t.card)));
        }
        if let Some(live) = app.live.get(&chat.address).filter(|l| !l.is_empty()) {
            spans.push(Span::styled(
                format!("  typing: {}", truncate(&super::text::one_line(live), 40)),
                t.accent(t.card).add_modifier(Modifier::ITALIC),
            ));
        }
        if a.list.is_none() {
            let used: usize = spans.iter().map(|s| width(&s.content)).sum();
            let conn = conn_span(app);
            let gap = usize::from(conv.width).saturating_sub(used + width(&conn.content) + 1);
            spans.push(Span::styled(" ".repeat(gap), t.on_card()));
            spans.push(conn);
        }
        f.render_widget(Paragraph::new(Line::from(spans)).style(t.on_card()), conv_header(a));
    } else if a.conv.is_some() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(" Welcome", t.dim(t.card)))).style(t.on_card()),
            conv_header(a),
        );
    }
}

fn conv_header(a: &Areas) -> Rect {
    let conv = a.conv.expect("conv");
    Rect { y: a.header.y, height: 1, x: conv.x, width: conv.width }
}

fn hint_pairs(app: &App) -> Vec<(String, &'static str)> {
    let k = |a: Action| app.keys.label(a);
    let mut v: Vec<(String, &'static str)> = Vec::new();
    match app.focus {
        Focus::Composer => {
            v.push((k(Action::Send), "send"));
            v.push((k(Action::Newline), "newline"));
            v.push((k(Action::Switcher), "switch"));
            v.push((k(Action::Cancel), "messages"));
            v.push((k(Action::Help), "help"));
        }
        Focus::History => {
            v.push((k(Action::Reply), "reply"));
            v.push((k(Action::Edit), "edit"));
            v.push((k(Action::Delete), "delete"));
            v.push((k(Action::Copy), "copy"));
            v.push((k(Action::Compose), "write"));
            v.push(("?".into(), "help"));
        }
        Focus::List => {
            v.push((k(Action::OpenChat), "open"));
            v.push((k(Action::Switcher), "switch"));
            v.push((k(Action::NewChat), "new chat"));
            v.push((k(Action::NextUnread), "unread"));
            v.push(("?".into(), "help"));
        }
    }
    v
}

fn draw_footer(f: &mut Frame, app: &App, r: Rect) {
    let t = &app.theme;
    f.render_widget(Block::default().style(t.on_card()), r);
    if let Popup::Command(c) = &app.popup {
        let line =
            Line::from(vec![Span::styled(":", t.accent(t.card)), Span::styled(c.text().to_string(), t.on_card())]);
        f.render_widget(Paragraph::new(line), r);
        f.set_cursor_position(Position::new(r.x + 1 + width(c.text()) as u16, r.y));
        return;
    }
    let right = format!("v{} ", app.version);
    let w = usize::from(r.width);
    let mut spans: Vec<Span> = Vec::new();
    if let Some((msg, _)) = &app.notice {
        spans.push(Span::styled(
            format!(" {}", truncate(msg, w.saturating_sub(right.len() + 2))),
            Style::default().fg(t.warn).bg(t.card),
        ));
    } else {
        spans.push(Span::styled(" ", t.on_card()));
        let mut used = 1;
        for (key, label) in hint_pairs(app) {
            let need = width(&key) + 1 + label.len() + 3;
            if used + need + right.len() > w {
                break;
            }
            spans.push(Span::styled(key, t.accent(t.card).add_modifier(Modifier::BOLD)));
            spans.push(Span::styled(format!(" {label}   "), t.dim(t.card)));
            used += need;
        }
    }
    let used: usize = spans.iter().map(|s| width(&s.content)).sum();
    spans.push(Span::styled(" ".repeat(w.saturating_sub(used + right.len())), t.on_card()));
    spans.push(Span::styled(right, t.dim(t.card)));
    f.render_widget(Paragraph::new(Line::from(spans)), r);
}

// ---- chat list -----------------------------------------------------------------------------

fn draw_list(f: &mut Frame, app: &mut App, r: Rect) {
    let t = app.theme.clone();
    f.render_widget(Block::default().style(t.on_card()), r);
    let w = usize::from(r.width);
    if app.chats.is_empty() {
        let lines = vec![
            Line::from(""),
            Line::from(Span::styled("  No chats yet", t.dim(t.card))),
            Line::from(""),
            Line::from(vec![
                Span::styled(
                    format!("  {}", app.keys.label(Action::NewChat)),
                    t.accent(t.card).add_modifier(Modifier::BOLD),
                ),
                Span::styled(" add a contact", t.dim(t.card)),
            ]),
        ];
        f.render_widget(Paragraph::new(lines).style(t.on_card()), r);
        return;
    }
    let rows_fit = usize::from(r.height) / 2;
    if rows_fit > 0 {
        if app.cur < app.list_top {
            app.list_top = app.cur;
        } else if app.cur >= app.list_top + rows_fit {
            app.list_top = app.cur + 1 - rows_fit;
        }
    }
    app.hit.list = r;
    let mut lines: Vec<Line> = Vec::new();
    for (idx, chat) in app.chats.iter().enumerate().skip(app.list_top).take(rows_fit) {
        app.hit.list_rows.push(idx);
        let selected = idx == app.cur;
        let bg = if selected && t.fills { t.select } else { t.card };
        let mut row_style = Style::default().fg(t.text).bg(bg);
        if selected && !t.fills {
            row_style = row_style.add_modifier(Modifier::REVERSED);
        }
        let bar = if selected && !t.fills {
            Span::styled(" ", row_style)
        } else if selected {
            Span::styled(
                glyph(app, "\u{258c}", ">"),
                Style::default().fg(if app.focus == Focus::List { t.secondary } else { t.primary }).bg(bg),
            )
        } else {
            Span::styled(" ", row_style)
        };
        let time = list_time(app, chat.last_msg().map_or(0.0, |m| m.ts));
        let name_w = w.saturating_sub(2 + width(&time) + 2);
        let mut name_style = row_style;
        if chat.unread > 0 {
            name_style = name_style.add_modifier(Modifier::BOLD);
        }
        let name = pad_right(&truncate(&chat.name, name_w), name_w);
        let time_style = if chat.unread > 0 { Style::default().fg(t.secondary).bg(bg) } else { t.dim(bg) };
        let l1 = Line::from(vec![
            bar.clone(),
            Span::styled(" ", row_style),
            Span::styled(name, name_style),
            Span::styled(format!(" {time} "), time_style),
        ]);
        let badge = if chat.unread > 0 { format!(" {} ", chat.unread.min(99)) } else { String::new() };
        let prev_w = w.saturating_sub(2 + width(&badge) + 2);
        let (preview, pstyle) = if idx != app.cur && !chat.composer.is_empty() {
            (format!("Draft: {}", super::text::one_line(chat.composer.text())), Style::default().fg(t.warn).bg(bg))
        } else {
            match chat.last_msg() {
                Some(m) => (preview_text(m), t.dim(bg)),
                None => ("No messages yet".to_string(), t.dim(bg)),
            }
        };
        let preview = pad_right(&truncate(&preview, prev_w), prev_w);
        let mut l2 = vec![Span::styled("  ", row_style), Span::styled(preview, pstyle)];
        if chat.unread > 0 {
            l2.push(Span::styled(
                badge,
                if t.fills {
                    Style::default().fg(t.on_primary).bg(t.primary).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().add_modifier(Modifier::BOLD | Modifier::REVERSED)
                },
            ));
        }
        l2.push(Span::styled(
            " ".repeat(w.saturating_sub(l2.iter().map(|s| width(&s.content)).sum::<usize>())),
            row_style,
        ));
        let l2 = Line::from(l2);
        let (l1, l2) = if selected && !t.fills { (reversed(l1), reversed(l2)) } else { (l1, l2) };
        lines.push(l1);
        lines.push(l2);
    }
    f.render_widget(Paragraph::new(lines).style(t.on_card()), r);
}

/// Selected row without colour fills: reverse the whole line.
fn reversed(line: Line<'static>) -> Line<'static> {
    Line::from(
        line.spans
            .into_iter()
            .map(|s| Span::styled(s.content, s.style.add_modifier(Modifier::REVERSED)))
            .collect::<Vec<_>>(),
    )
}

fn preview_text(m: &Msg) -> String {
    let text = if m.text.is_empty() && m.att { "[attachment]".to_string() } else { super::text::one_line(&m.text) };
    if m.mine {
        format!("You: {text}")
    } else {
        text
    }
}

// ---- conversation --------------------------------------------------------------------------

fn composer_geometry(app: &App, conv: Rect) -> (usize, usize, usize) {
    // (text width, text lines shown, total lines of text)
    let text_w = usize::from(conv.width).saturating_sub(5).max(8);
    let total = app.chat().map_or(1, |c| c.composer.layout(text_w).0.len());
    (text_w, total.clamp(1, MAX_COMPOSER_LINES), total)
}

fn draw_conversation(f: &mut Frame, app: &mut App, conv: Rect) {
    let t = app.theme.clone();
    f.render_widget(Block::default().style(t.base()), conv);
    if app.chat().is_none() {
        draw_welcome(f, app, conv);
        return;
    }
    let (text_w, shown, _) = composer_geometry(app, conv);
    let ctx = usize::from(app.chat().is_some_and(|c| c.reply_to.is_some() || c.editing.is_some()));
    let comp_h = (1 + ctx + shown) as u16;
    let comp = Rect { y: conv.y + conv.height.saturating_sub(comp_h), height: comp_h.min(conv.height), ..conv };
    let hist = Rect { height: conv.height.saturating_sub(comp_h), ..conv };
    app.hit.hist = hist;
    app.hit.composer = comp;
    app.hit.comp_width = text_w;
    draw_history(f, app, hist);
    draw_composer(f, app, comp, text_w, shown, ctx == 1);
}

fn draw_welcome(f: &mut Frame, app: &App, conv: Rect) {
    let t = &app.theme;
    let lines = vec![
        Line::from(""),
        Line::from(""),
        Line::from(Span::styled("Welcome to MIGA", t.bold(t.bg))),
        Line::from(""),
        Line::from(Span::styled("Private messages, end to end encrypted.", t.dim(t.bg))),
        Line::from(""),
        Line::from(vec![
            Span::styled(app.keys.label(Action::NewChat), t.accent(t.bg).add_modifier(Modifier::BOLD)),
            Span::styled("  add a contact by address", t.dim(t.bg)),
        ]),
        Line::from(vec![
            Span::styled(app.keys.label(Action::Address), t.accent(t.bg).add_modifier(Modifier::BOLD)),
            Span::styled("  show your own address", t.dim(t.bg)),
        ]),
        Line::from(vec![
            Span::styled("?", t.accent(t.bg).add_modifier(Modifier::BOLD)),
            Span::styled("  help and all keys", t.dim(t.bg)),
        ]),
    ];
    f.render_widget(Paragraph::new(lines).alignment(Alignment::Center).style(t.base()), conv);
}

struct Built {
    lines: Vec<Line<'static>>,
    row_of: Vec<Option<usize>>,
    /// (first, last) line of each row, by row index.
    spans: Vec<(usize, usize)>,
}

fn draw_history(f: &mut Frame, app: &mut App, r: Rect) {
    let h = usize::from(r.height);
    app.view_h = h;
    let built = build_history(app, usize::from(r.width));
    let total = built.lines.len();
    let max_off = total.saturating_sub(h);
    app.offset = app.offset.min(max_off);
    if app.reveal {
        if let Some(sel) = app.chat().and_then(|c| c.sel) {
            if let Some(&(first, last)) = built.spans.get(sel) {
                let top = total.saturating_sub(h + app.offset);
                let bottom = total - app.offset;
                if first < top {
                    app.offset = (total - h.min(total) - first.min(total - h.min(total))).min(max_off);
                } else if last + 1 > bottom {
                    app.offset = total.saturating_sub(last + 1);
                }
            }
        }
        app.reveal = false;
    }
    let bottom = total - app.offset;
    let top = bottom.saturating_sub(h);
    let slice: Vec<Line> = built.lines[top..bottom].to_vec();
    let pad = h - slice.len();
    let mut hit: Vec<Option<usize>> = vec![None; pad];
    hit.extend(built.row_of[top..bottom].iter().copied());
    app.hit.hist_lines = hit;
    let body = Rect { y: r.y + pad as u16, height: (h - pad) as u16, ..r };
    f.render_widget(Paragraph::new(slice).style(app.theme.base()), body);
    if app.offset > 0 && h > 2 {
        let t = &app.theme;
        let label = format!(" {} more below ", glyph(app, "\u{2193}", "v"));
        let w = width(&label) as u16;
        let pill =
            Rect { x: r.x + r.width.saturating_sub(w + 2), y: r.y + r.height - 1, width: w.min(r.width), height: 1 };
        let style = if t.fills {
            Style::default().fg(t.on_primary).bg(t.primary)
        } else {
            Style::default().add_modifier(Modifier::REVERSED)
        };
        f.render_widget(Paragraph::new(Span::styled(label, style)), pill);
    }
}

type Seg = (String, Style);

fn seg_width(segs: &[Seg]) -> usize {
    segs.iter().map(|s| width(&s.0)).sum()
}

fn build_history(app: &App, w: usize) -> Built {
    let t = &app.theme;
    let chat = app.chat().expect("chat");
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut row_of: Vec<Option<usize>> = Vec::new();
    let mut spans: Vec<(usize, usize)> = vec![(0, 0); chat.rows.len()];
    let push =
        |lines: &mut Vec<Line<'static>>, row_of: &mut Vec<Option<usize>>, l: Line<'static>, row: Option<usize>| {
            lines.push(l);
            row_of.push(row);
        };
    let usable = w.saturating_sub(3).max(10);
    let max_outer = (usable * 4 / 5).clamp(14.min(usable), usable);
    let inner_max = max_outer.saturating_sub(2).max(6);
    let mut last_day = None;
    let mut first = true;
    for (idx, row) in chat.rows.iter().enumerate() {
        let day = day_of(app, row.ts());
        if day != last_day {
            if !first {
                push(&mut lines, &mut row_of, Line::from(""), None);
            }
            let label = format!(" {} ", day_label(app, row.ts()));
            let side = w.saturating_sub(width(&label)) / 2;
            let rule = glyph(app, "\u{2500}", "-");
            let text = format!("{}{}{}", rule.repeat(side.min(10)), label, rule.repeat(side.min(10)));
            push(
                &mut lines,
                &mut row_of,
                Line::from(Span::styled(text, t.dim(t.bg))).alignment(Alignment::Center),
                None,
            );
            last_day = day;
            push(&mut lines, &mut row_of, Line::from(""), None);
        } else if !first {
            push(&mut lines, &mut row_of, Line::from(""), None);
        }
        first = false;
        let start = lines.len();
        match row {
            Row::Gone { mine, .. } => {
                let txt = if *mine { "you deleted a message" } else { "message deleted" };
                let l = Line::from(Span::styled(
                    format!("  {} {txt} ", glyph(app, "\u{2715}", "x")),
                    t.dim(t.bg).add_modifier(Modifier::ITALIC),
                ));
                let l = if *mine { l.alignment(Alignment::Right) } else { l };
                push(&mut lines, &mut row_of, l, Some(idx));
            }
            Row::Msg(m) => {
                let selected = chat.sel == Some(idx) && app.focus == Focus::History;
                for l in message_lines(app, &chat.name, m, selected, w, inner_max) {
                    push(&mut lines, &mut row_of, l, Some(idx));
                }
            }
        }
        spans[idx] = (start, lines.len() - 1);
    }
    Built { lines, row_of, spans }
}

fn tick_for(app: &App, m: &Msg) -> (String, Style) {
    let t = &app.theme;
    let bg = if t.fills { t.bubble_out } else { t.bg };
    let dim = if t.fills { t.on_primary_dim } else { t.muted };
    match (m.state, m.delivery) {
        (State::Pending, _) => (glyph(app, "\u{2026}", "..").into(), Style::default().fg(dim).bg(bg)),
        (State::Failed, _) => (
            glyph(app, "\u{2717} failed", "x failed").into(),
            Style::default().fg(t.error).bg(bg).add_modifier(Modifier::BOLD),
        ),
        (_, Delivery::Read) => (
            glyph(app, "\u{2713}\u{2713}", "vv").into(),
            Style::default().fg(t.read).bg(bg).add_modifier(Modifier::BOLD),
        ),
        (_, Delivery::Delivered) => (glyph(app, "\u{2713}\u{2713}", "vv").into(), Style::default().fg(dim).bg(bg)),
        _ => (glyph(app, "\u{2713}", "v").into(), Style::default().fg(dim).bg(bg)),
    }
}

fn message_lines(
    app: &App,
    peer_name: &str,
    m: &Msg,
    selected: bool,
    w: usize,
    inner_max: usize,
) -> Vec<Line<'static>> {
    let t = &app.theme;
    let mine = m.mine;
    let (bg, fg, dim_fg, accent_fg) = if !t.fills {
        (t.bg, t.text, t.muted, t.secondary)
    } else if mine {
        (if selected { t.secondary } else { t.bubble_out }, t.on_primary, t.on_primary_dim, t.on_primary)
    } else {
        (if selected { t.select } else { t.bubble_in }, t.text, t.muted, t.secondary)
    };
    let sty = |c| Style::default().fg(c).bg(bg);
    let body_style = if t.fills {
        sty(fg)
    } else if selected {
        sty(fg).add_modifier(Modifier::BOLD)
    } else {
        sty(fg)
    };
    // Content lines as segment lists.
    let mut content: Vec<Vec<Seg>> = Vec::new();
    if let Some(q) = &m.reply {
        let who = if q.mine { "You" } else { peer_name };
        let quote = truncate(&format!("{who}: {}", q.text), inner_max.saturating_sub(2));
        content.push(vec![
            (glyph(app, "\u{258e} ", "| ").into(), sty(accent_fg)),
            (quote, sty(dim_fg).add_modifier(Modifier::ITALIC)),
        ]);
    }
    for l in wrap(&m.text, inner_max) {
        content.push(vec![(l, body_style)]);
    }
    if m.att {
        let label = format!("[attachment: {}]  o opens", m.att_info);
        content.push(vec![(truncate(&label, inner_max), sty(dim_fg).add_modifier(Modifier::ITALIC))]);
    }
    if content.iter().all(|c| c.iter().all(|s| s.0.is_empty())) {
        content.push(vec![(" ".into(), body_style)]);
    }
    // Meta (edited, time, ticks).
    let mut meta: Vec<Seg> = Vec::new();
    if m.edited {
        meta.push(("edited ".into(), sty(dim_fg).add_modifier(Modifier::ITALIC)));
    }
    meta.push((clock(app, m.ts), sty(dim_fg)));
    if mine {
        let (tick, style) = tick_for(app, m);
        let style = style.bg(bg);
        meta.push((" ".into(), sty(dim_fg)));
        meta.push((tick, style));
    }
    let meta_w = seg_width(&meta);
    let last_w = content.last().map_or(0, |c| seg_width(c));
    let longest = content.iter().map(|c| seg_width(c)).max().unwrap_or(0);
    let inline = last_w + 2 + meta_w <= inner_max && content.len() > usize::from(m.reply.is_some());
    let inner_w = if inline { longest.max(last_w + 2 + meta_w) } else { longest.max(meta_w) };
    let mut out_lines: Vec<Vec<Seg>> = content;
    if inline {
        let last = out_lines.last_mut().expect("content");
        let gap = inner_w - seg_width(last) - meta_w;
        last.push((" ".repeat(gap), sty(fg)));
        last.extend(meta);
    } else {
        let gap = inner_w - meta_w;
        let mut l = vec![(" ".repeat(gap), sty(fg))];
        l.extend(meta);
        out_lines.push(l);
    }
    // Place: margins, bar, padding.
    let bubble_w = inner_w + 2;
    let left_margin = if mine { w.saturating_sub(bubble_w + 1 + usize::from(!t.fills) * 2) } else { 2 };
    out_lines
        .into_iter()
        .map(|mut segs| {
            let used = seg_width(&segs);
            if used < inner_w {
                segs.push((" ".repeat(inner_w - used), sty(fg)));
            }
            let mut spans: Vec<Span<'static>> = Vec::new();
            let marker = if selected { glyph(app, "\u{258e}", ">") } else { " " };
            if mine {
                spans.push(Span::styled(
                    if left_margin > 0 { marker.to_string() } else { String::new() },
                    Style::default().fg(t.secondary).bg(t.bg),
                ));
                spans.push(Span::styled(" ".repeat(left_margin.saturating_sub(1)), t.base()));
            } else {
                spans.push(Span::styled(marker.to_string(), Style::default().fg(t.secondary).bg(t.bg)));
                spans.push(Span::styled(" ".repeat(left_margin.saturating_sub(1)), t.base()));
            }
            if t.fills {
                spans.push(Span::styled(" ", sty(fg)));
                spans.extend(segs.into_iter().map(|(s, st)| Span::styled(s, st)));
                spans.push(Span::styled(" ", sty(fg)));
            } else {
                let bar_color = if mine { t.primary } else { t.muted };
                let bar = if mine { glyph(app, "\u{2503}", "|") } else { glyph(app, "\u{258e}", "|") };
                spans.push(Span::styled(format!("{bar} "), Style::default().fg(bar_color).bg(t.bg)));
                spans.extend(segs.into_iter().map(|(s, st)| Span::styled(s, st)));
            }
            Line::from(spans)
        })
        .collect()
}

fn draw_composer(f: &mut Frame, app: &mut App, r: Rect, text_w: usize, shown: usize, has_ctx: bool) {
    let t = app.theme.clone();
    f.render_widget(Block::default().style(t.on_card()), r);
    let focus = app.focus == Focus::Composer && matches!(app.popup, Popup::None);
    let chat = app.chat().expect("chat");
    let mut lines: Vec<Line> = vec![Line::from("")];
    if has_ctx {
        let ctx = if let Some(id) = &chat.editing {
            let _ = id;
            Line::from(vec![
                Span::styled(
                    format!(" {} Editing message", glyph(app, "\u{270e}", "*")),
                    t.accent(t.card).add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!("  {} to cancel", app.keys.label(Action::Cancel)), t.dim(t.card)),
            ])
        } else {
            let quoted = chat.reply_to.as_ref().and_then(|id| chat.msg_by_id(id));
            let who = quoted.map_or("", |m| if m.mine { "yourself" } else { chat.name.as_str() });
            let text = quoted.map(|m| super::text::one_line(&m.text)).unwrap_or_default();
            let head = format!(" {} Replying to {who}", glyph(app, "\u{21a9}", ">"));
            let room = usize::from(r.width).saturating_sub(width(&head) + 12);
            Line::from(vec![
                Span::styled(head, t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(format!("  {}", truncate(&text, room)), t.dim(t.card)),
            ])
        };
        lines.push(ctx);
    }
    let (ranges, (crow, ccol)) = chat.composer.layout(text_w);
    let first = if crow >= shown { crow + 1 - shown } else { 0 };
    let text = chat.composer.text();
    let prompt_style = if focus { t.accent(t.card).add_modifier(Modifier::BOLD) } else { t.dim(t.card) };
    if chat.composer.is_empty() {
        let ph = format!("Message {}", truncate(&chat.name, 24));
        lines.push(Line::from(vec![
            Span::styled(format!(" {} ", glyph(app, "\u{203a}", ">")), prompt_style),
            Span::styled(ph, t.dim(t.card)),
        ]));
    } else {
        for (i, (s, e)) in ranges.iter().enumerate().skip(first).take(shown) {
            let prompt = if i == 0 { format!(" {} ", glyph(app, "\u{203a}", ">")) } else { "   ".into() };
            let mut spans = vec![
                Span::styled(prompt, prompt_style),
                Span::styled(text[*s..*e].trim_end_matches(' ').to_string(), t.on_card()),
            ];
            if i + 1 == first + shown && first + shown < ranges.len() {
                spans.push(Span::styled(format!(" {}", glyph(app, "\u{2026}", "...")), t.dim(t.card)));
            }
            lines.push(Line::from(spans));
        }
    }
    let ctx_rows = usize::from(has_ctx);
    f.render_widget(Paragraph::new(lines).style(t.on_card()), r);
    if focus {
        let y = r.y + 1 + ctx_rows as u16 + (crow - first.min(crow)) as u16;
        f.set_cursor_position(Position::new(r.x + 3 + ccol as u16, y.min(r.y + r.height.saturating_sub(1))));
    }
}

// ---- popups --------------------------------------------------------------------------------

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect { x: area.x + (area.width - w) / 2, y: area.y + (area.height - h) / 3, width: w, height: h }
}

fn panel<'a>(app: &App, title: &'a str) -> Block<'a> {
    let t = &app.theme;
    Block::default()
        .borders(Borders::ALL)
        .border_set(border_set(app))
        .border_style(Style::default().fg(t.secondary).bg(t.card))
        .title(Span::styled(format!(" {title} "), Style::default().fg(t.text).bg(t.card).add_modifier(Modifier::BOLD)))
        .style(t.on_card())
}

fn draw_popup(f: &mut Frame, app: &mut App, area: Rect, _footer: Rect) {
    let t = app.theme.clone();
    let popup = app.popup.clone();
    match popup {
        Popup::None | Popup::Command(_) => {}
        Popup::Help { scroll } => draw_help(f, app, area, scroll),
        Popup::Address => {
            let r = centered(area, 66, 11);
            f.render_widget(Clear, r);
            let a = &app.me;
            let (l1, l2) = if app.addr_reveal {
                (a[..32].to_string(), a[32..].to_string())
            } else {
                (format!("{}{}{}", &a[..6], glyph(app, "\u{2022}", "*").repeat(20), &a[58..]), String::new())
            };
            let key = |k: &str| Span::styled(format!("  {k}"), t.accent(t.card).add_modifier(Modifier::BOLD));
            let lines = vec![
                Line::from(""),
                Line::from(Span::styled(format!("  {l1}"), t.bold(t.card))),
                Line::from(Span::styled(format!("  {l2}"), t.bold(t.card))),
                Line::from(""),
                Line::from(Span::styled("  Share this address; anyone with it can message you.", t.dim(t.card))),
                Line::from(Span::styled("  It is hidden here so a screen share does not leak it.", t.dim(t.card))),
                Line::from(""),
                Line::from(vec![
                    key("r"),
                    Span::styled(if app.addr_reveal { " hide   " } else { " reveal   " }, t.dim(t.card)),
                    Span::styled("c", t.accent(t.card).add_modifier(Modifier::BOLD)),
                    Span::styled(" copy   ", t.dim(t.card)),
                    Span::styled("Shift+Q", t.accent(t.card).add_modifier(Modifier::BOLD)),
                    Span::styled(" QR code   ", t.dim(t.card)),
                    Span::styled("Esc", t.accent(t.card).add_modifier(Modifier::BOLD)),
                    Span::styled(" close", t.dim(t.card)),
                ]),
            ];
            f.render_widget(Paragraph::new(lines).block(panel(app, "Your address")), r);
        }
        Popup::Link { code, lines, url } => {
            let qr_w = lines.first().map_or(0, |l| width(l)) as u16;
            let h = (lines.len() as u16 + 9).min(area.height);
            let r = centered(area, (qr_w + 8).max(70), h);
            f.render_widget(Clear, r);
            let mut out: Vec<Line> = Vec::new();
            let white = Style::default().fg(Color::White).bg(Color::Black);
            for l in &lines {
                out.push(Line::from(vec![Span::styled("  ", t.on_card()), Span::styled(l.clone(), white)]));
            }
            out.push(Line::from(""));
            out.push(Line::from(vec![
                Span::styled("  Code: ", t.dim(t.card)),
                Span::styled(miga_core::link::format_link_code(&code), t.bold(t.card)),
            ]));
            out.push(Line::from(Span::styled(
                "  Scan with the MIGA app on your own phone, or type the code on the new device.",
                t.dim(t.card),
            )));
            out.push(Line::from(Span::styled(
                format!("  {}", truncate(&url.replace(&code, "<code>"), 64)),
                t.dim(t.card),
            )));
            out.push(Line::from(vec![
                Span::styled("  c", t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(" copy code   ", t.dim(t.card)),
                Span::styled("Esc", t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(" cancel (valid 10 minutes)", t.dim(t.card)),
            ]));
            f.render_widget(Paragraph::new(out).block(panel(app, "Link a device")), r);
        }
        Popup::Qr { title, lines, note } => {
            let qr_w = lines.first().map_or(0, |l| width(l)) as u16;
            let h = (lines.len() as u16 + 5).min(area.height);
            let r = centered(area, (qr_w + 8).max(52), h);
            f.render_widget(Clear, r);
            let white = Style::default().fg(Color::White).bg(Color::Black);
            let mut out: Vec<Line> = Vec::new();
            for l in &lines {
                out.push(Line::from(vec![Span::styled("  ", t.on_card()), Span::styled(l.clone(), white)]));
            }
            out.push(Line::from(""));
            out.push(Line::from(Span::styled(format!("  {note}"), t.dim(t.card))));
            f.render_widget(Paragraph::new(out).block(panel(app, &title)), r);
        }
        Popup::Devices { sel } => {
            let h = (app.devices.len() as u16 + 8).min(area.height);
            let r = centered(area, 72, h);
            f.render_widget(Clear, r);
            let mut out = vec![Line::from("")];
            out.push(Line::from(Span::styled(
                format!("  {} (this device)", app.my_device.get(..12).unwrap_or(&app.my_device)),
                t.bold(t.card),
            )));
            if app.devices.is_empty() {
                out.push(Line::from(Span::styled("  No other devices linked yet.", t.dim(t.card))));
            }
            for (i, (addr, label)) in app.devices.iter().enumerate() {
                let on = i == sel;
                let style = if on { t.accent(t.card).add_modifier(Modifier::REVERSED) } else { t.on_card() };
                out.push(Line::from(Span::styled(format!("  {}  {label}", addr.get(..12).unwrap_or(addr)), style)));
            }
            out.push(Line::from(""));
            out.push(Line::from(vec![
                Span::styled("  a", t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(" add (QR)   ", t.dim(t.card)),
                Span::styled("c", t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(" copy history from it   ", t.dim(t.card)),
                Span::styled("x", t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(" remove   ", t.dim(t.card)),
                Span::styled("Esc", t.accent(t.card).add_modifier(Modifier::BOLD)),
            ]));
            f.render_widget(Paragraph::new(out).block(panel(app, "Devices")), r);
        }
        Popup::Safety { peer } => {
            let r = centered(area, 60, 11);
            f.render_widget(Clear, r);
            let n = miga_core::crypto::safety_number(&app.me, &peer)
                .map(|n| miga_core::crypto::group_safety(&n))
                .unwrap_or_default();
            let (l1, l2) = (n.get(..35).unwrap_or(&n).to_string(), n.get(36..).unwrap_or("").to_string());
            let name = app.chats.iter().find(|c| c.address == peer).map_or("", |c| c.name.as_str());
            let ver = if app.verified.contains(&peer) { "Verified" } else { "Not verified" };
            let out = vec![
                Line::from(""),
                Line::from(Span::styled(format!("  With {name}: compare this number in person."), t.dim(t.card))),
                Line::from(""),
                Line::from(Span::styled(format!("  {l1}"), t.bold(t.card))),
                Line::from(Span::styled(format!("  {l2}"), t.bold(t.card))),
                Line::from(""),
                Line::from(Span::styled(format!("  Status: {ver}"), t.accent(t.card))),
                Line::from(vec![
                    Span::styled("  v", t.accent(t.card).add_modifier(Modifier::BOLD)),
                    Span::styled(" mark verified / not   ", t.dim(t.card)),
                    Span::styled("c", t.accent(t.card).add_modifier(Modifier::BOLD)),
                    Span::styled(" copy   ", t.dim(t.card)),
                    Span::styled("Esc", t.accent(t.card).add_modifier(Modifier::BOLD)),
                ]),
            ];
            f.render_widget(Paragraph::new(out).block(panel(app, "Safety number")), r);
        }
        Popup::Search { query, global, sel } => {
            let results = app.search_results(query.text(), global);
            let h = (results.len().clamp(1, 10) + 4) as u16;
            let r = centered(area, 70, h);
            f.render_widget(Clear, r);
            let mut out = vec![Line::from(vec![
                Span::styled(
                    format!(" {} ", glyph(app, "\u{203a}", ">")),
                    t.accent(t.card).add_modifier(Modifier::BOLD),
                ),
                Span::styled(query.text().to_string(), t.on_card()),
            ])];
            out.push(Line::from(""));
            if results.is_empty() {
                out.push(Line::from(Span::styled(
                    if query.is_empty() { "  Type to search." } else { "  No match." },
                    t.dim(t.card),
                )));
            }
            let skip = sel.saturating_sub(9);
            for (n, (_, _, line)) in results.iter().enumerate().skip(skip).take(10) {
                let style = if n == sel { t.accent(t.card).add_modifier(Modifier::REVERSED) } else { t.on_card() };
                out.push(Line::from(Span::styled(format!(" {}", pad_right(&truncate(line, 66), 66)), style)));
            }
            let title = if global { "Search all chats" } else { "Search this chat" };
            f.render_widget(Paragraph::new(out).block(panel(app, title)), r);
            f.set_cursor_position(Position::new(r.x + 4 + width(query.text()) as u16, r.y + 1));
        }
        Popup::Confirm { prompt, .. } => {
            let r = centered(area, 66, 7);
            f.render_widget(Clear, r);
            let out = vec![
                Line::from(""),
                Line::from(Span::styled(format!("  {}", truncate(&prompt, 62)), t.on_card())),
                Line::from(""),
                Line::from(vec![
                    Span::styled("  y", t.accent(t.card).add_modifier(Modifier::BOLD)),
                    Span::styled(" yes   ", t.dim(t.card)),
                    Span::styled("n", t.accent(t.card).add_modifier(Modifier::BOLD)),
                    Span::styled(" no", t.dim(t.card)),
                ]),
            ];
            f.render_widget(Paragraph::new(out).block(panel(app, "Confirm")), r);
        }
        Popup::Switcher { query, sel } => {
            let results = app.switcher_results(query.text());
            let h = (results.len().clamp(1, 8) + 4) as u16;
            let r = centered(area, 56, h);
            f.render_widget(Clear, r);
            let mut lines = vec![Line::from(vec![
                Span::styled(
                    format!(" {} ", glyph(app, "\u{203a}", ">")),
                    t.accent(t.card).add_modifier(Modifier::BOLD),
                ),
                Span::styled(query.text().to_string(), t.on_card()),
            ])];
            lines.push(Line::from(""));
            let inner_w = usize::from(r.width).saturating_sub(2);
            if results.is_empty() {
                lines.push(Line::from(Span::styled("  No match. Ctrl+N adds a new chat.", t.dim(t.card))));
            }
            let skip = sel.saturating_sub(7);
            for (n, i) in results.iter().enumerate().skip(skip).take(8) {
                let c = &app.chats[*i];
                let on = n == sel;
                let bg = if on && t.fills { t.select } else { t.card };
                let mut st = Style::default().fg(t.text).bg(bg);
                if on && !t.fills {
                    st = st.add_modifier(Modifier::REVERSED);
                }
                let badge = if c.unread > 0 { format!(" {} new", c.unread) } else { String::new() };
                let name = format!(" {}", c.name);
                let addr = format!("  {}", short_addr(&c.address));
                let gap = inner_w.saturating_sub(width(&name) + width(&addr) + width(&badge));
                lines.push(Line::from(vec![
                    Span::styled(name, st),
                    Span::styled(addr, if t.fills { t.dim(bg) } else { st }),
                    Span::styled(" ".repeat(gap), st),
                    Span::styled(badge, Style::default().fg(t.secondary).bg(bg)),
                ]));
            }
            f.render_widget(Paragraph::new(lines).block(panel(app, "Switch chat")), r);
            f.set_cursor_position(Position::new(r.x + 4 + width(query.text()) as u16, r.y + 1));
        }
        Popup::NewChat { address, name, field, error } => {
            let r = centered(area, 72, 11);
            f.render_widget(Clear, r);
            let lab = |s: &str, on: bool| {
                Span::styled(
                    format!("  {s}"),
                    if on { t.accent(t.card).add_modifier(Modifier::BOLD) } else { t.dim(t.card) },
                )
            };
            let mut lines = vec![
                Line::from(""),
                Line::from(lab("Address", field == 0)),
                Line::from(vec![
                    Span::styled("  ", t.on_card()),
                    Span::styled(truncate_tail(address.text(), 66), t.on_card()),
                ]),
                Line::from(lab("Name (optional)", field == 1)),
                Line::from(vec![Span::styled("  ", t.on_card()), Span::styled(name.text().to_string(), t.on_card())]),
                Line::from(""),
            ];
            lines.push(match &error {
                Some(e) => Line::from(Span::styled(format!("  {e}"), Style::default().fg(t.error).bg(t.card))),
                None => Line::from(Span::styled(
                    "  Paste the 64-character address of the person you want to message.",
                    t.dim(t.card),
                )),
            });
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  Enter", t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(" add   ", t.dim(t.card)),
                Span::styled("Tab", t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(" next field   ", t.dim(t.card)),
                Span::styled("Esc", t.accent(t.card).add_modifier(Modifier::BOLD)),
                Span::styled(" cancel", t.dim(t.card)),
            ]));
            f.render_widget(Paragraph::new(lines).block(panel(app, "New chat")), r);
            let (txt, row) =
                if field == 0 { (truncate_tail(address.text(), 66), 3) } else { (name.text().to_string(), 5) };
            f.set_cursor_position(Position::new(r.x + 3 + width(&txt) as u16, r.y + row));
        }
        Popup::ConfirmDelete { .. } => {
            confirm(
                f,
                app,
                area,
                "Delete message",
                "Delete this message for everyone?",
                "It disappears for both of you. This cannot be undone.",
                "y delete   n cancel",
            );
        }
        Popup::ConfirmQuit => {
            confirm(
                f,
                app,
                area,
                "Quit",
                "Quit MIGA?",
                "Unsent drafts are saved and will be here next time.",
                "y quit   n stay",
            );
        }
    }
}

fn truncate_tail(s: &str, max: usize) -> String {
    if width(s) <= max {
        return s.to_string();
    }
    let skip = s.chars().count().saturating_sub(max.saturating_sub(1));
    format!("\u{2026}{}", s.chars().skip(skip).collect::<String>())
}

fn confirm(f: &mut Frame, app: &App, area: Rect, title: &str, q: &str, detail: &str, keys: &str) {
    let t = &app.theme;
    let r = centered(area, 66, 8);
    f.render_widget(Clear, r);
    let mut k: Vec<Span> = vec![Span::styled("  ", t.on_card())];
    for (i, part) in keys.split("   ").enumerate() {
        let (key, label) = part.split_once(' ').unwrap_or((part, ""));
        if i > 0 {
            k.push(Span::styled("   ", t.on_card()));
        }
        k.push(Span::styled(key.to_string(), t.accent(t.card).add_modifier(Modifier::BOLD)));
        k.push(Span::styled(format!(" {label}"), t.dim(t.card)));
    }
    let lines = vec![
        Line::from(""),
        Line::from(Span::styled(format!("  {q}"), t.bold(t.card))),
        Line::from(Span::styled(
            format!("  {}", truncate(detail, usize::from(r.width).saturating_sub(4))),
            t.dim(t.card),
        )),
        Line::from(""),
        Line::from(k),
    ];
    f.render_widget(Paragraph::new(lines).block(panel(app, title)), r);
}

fn draw_help(f: &mut Frame, app: &App, area: Rect, scroll: usize) {
    let t = &app.theme;
    let w = 78.min(area.width);
    let h = area.height.saturating_sub(2).min(38);
    let mut r = centered(area, w, h);
    r.y = area.y + (area.height - r.height) / 2;
    f.render_widget(Clear, r);
    let sections: [(&str, &[Action]); 3] = [
        (
            "Anywhere",
            &[
                Action::Switcher,
                Action::NewChat,
                Action::NextUnread,
                Action::PrevChat,
                Action::NextChat,
                Action::FocusNext,
                Action::Back,
                Action::Address,
                Action::Help,
                Action::Quit,
            ],
        ),
        ("Composer", &[Action::Send, Action::Newline, Action::EditLast, Action::OpenEditor, Action::Cancel]),
        (
            "Chat list and messages",
            &[
                Action::Down,
                Action::Up,
                Action::Top,
                Action::Bottom,
                Action::PageUp,
                Action::PageDown,
                Action::OpenChat,
                Action::Reply,
                Action::Edit,
                Action::Delete,
                Action::Copy,
                Action::OpenLink,
                Action::Compose,
            ],
        ),
    ];
    let key_w = 33usize;
    let mut lines: Vec<Line> = Vec::new();
    for (title, actions) in sections {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("  {title}"),
            Style::default().fg(t.secondary).bg(t.card).add_modifier(Modifier::BOLD),
        )));
        for a in actions {
            let keys: Vec<String> = app.keys.keys_for(*a).iter().map(|c| c.label()).collect();
            if keys.is_empty() {
                continue;
            }
            lines.push(Line::from(vec![
                Span::styled(
                    format!("  {}", pad_right(&truncate(&keys.join(" / "), key_w - 1), key_w)),
                    t.bold(t.card),
                ),
                Span::styled(describe(*a).to_string(), t.dim(t.card)),
            ]));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("  Config (read only): ~/.config/miga/config.toml", t.dim(t.card))));
    let body_h = usize::from(r.height).saturating_sub(3);
    let max_scroll = lines.len().saturating_sub(body_h);
    let scroll = scroll.min(max_scroll);
    let mut shown: Vec<Line> = lines.into_iter().skip(scroll).take(body_h).collect();
    while shown.len() < body_h {
        shown.push(Line::from(""));
    }
    shown.push(Line::from(vec![
        Span::styled("  Esc", t.accent(t.card).add_modifier(Modifier::BOLD)),
        Span::styled(" close   ", t.dim(t.card)),
        Span::styled("\u{2191}\u{2193}", t.accent(t.card).add_modifier(Modifier::BOLD)),
        Span::styled(" scroll", t.dim(t.card)),
    ]));
    f.render_widget(Paragraph::new(shown).block(panel(app, "Help")), r);
}

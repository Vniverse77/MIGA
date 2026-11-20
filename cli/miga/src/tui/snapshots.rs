//! Screen snapshots on ratatui's `TestBackend`. Goldens live in `snapshots/*.txt`;
//! run with `UPDATE_SNAPSHOTS=1 cargo test` to rewrite them after an intended change.
use super::app::tests::{app, key, msg, seed, typed, ANNA, BORIS};
use super::app::{App, Focus};
use super::theme::{ColorMode, Theme};
use super::ui;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::{json, Value};

const NOW: f64 = 1_700_000_000_000.0;
const MIN: f64 = 60_000.0;

fn render(app: &mut App, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| ui::draw(f, app)).unwrap();
    let buf = term.backend().buffer().clone();
    let mut out = String::new();
    for y in 0..h {
        let mut line = String::new();
        let mut x = 0;
        while x < w {
            let cell = &buf[(x, y)];
            line.push_str(cell.symbol());
            x += unicode_width::UnicodeWidthStr::width(cell.symbol()).max(1) as u16;
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

fn check(name: &str, actual: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tui/snapshots").join(format!("{name}.txt"));
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("missing snapshot {name}; run with UPDATE_SNAPSHOTS=1"));
    assert_eq!(
        actual, expected,
        "snapshot {name} differs; run with UPDATE_SNAPSHOTS=1 if the change is intended\n{actual}"
    );
}

fn reply_msg(id: &str, text: &str, ts: f64, quoted: &str, from: &str) -> Value {
    let mut m = msg(id, true, text, ts);
    m["reply"] = json!({"id": "x", "from": from, "text": quoted});
    m
}

fn sample() -> App {
    let t0 = NOW - 30.0 * MIN;
    let mut own = msg("m3", true, "yes, around eight. I can bring the maps \u{1F5FA}\u{FE0F}", t0 + 4.0 * MIN);
    own["delivery"] = json!("read");
    let mut sent = msg("m5", true, "see you there", t0 + 9.0 * MIN);
    sent["delivery"] = json!("delivered");
    let mut edited = msg("m1", false, "are you coming tonight? The usual place, same time as last week.", t0);
    edited["edited"] = json!(t0 + MIN);
    let mut a = app(vec![
        seed(
            ANNA,
            "Anna",
            vec![
                msg("m0", false, "morning!", t0 - 86_400_000.0),
                edited,
                msg("m2", false, "ok", t0 + 2.0 * MIN),
                own,
                reply_msg("m4", "which one is that?", t0 + 6.0 * MIN, "The usual place", ANNA),
                sent,
            ],
        ),
        seed(
            BORIS,
            "Boris",
            vec![
                msg("b1", false, "build is green again", t0 + 20.0 * MIN),
                msg("b2", false, "ship it?", t0 + 21.0 * MIN),
            ],
        ),
        seed(
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "Chen Wei",
            vec![msg("c1", true, "thanks for the notes", t0 - 3.0 * 86_400_000.0)],
        ),
        seed("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "dddddddd...", vec![]),
    ]);
    a.now = NOW;
    a.chats[1].last_read = 0.0;
    // Open Anna.
    a.open_chat(a.chats.iter().position(|c| c.name == "Anna").unwrap());
    a.chats[0].last_read = 0.0;
    a
}

fn alt(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::ALT)
}

#[test]
fn wide_conversation() {
    let mut a = sample();
    a.mark_read();
    check("wide_conversation", &render(&mut a, 100, 28));
}

#[test]
fn wide_history_selection_and_reply_context() {
    let mut a = sample();
    a.mark_read();
    a.handle_key(key(KeyCode::Esc));
    a.handle_key(key(KeyCode::Char('k')));
    a.handle_key(key(KeyCode::Char('r')));
    typed(&mut a, "the old caf\u{e9} on Main Street");
    check("reply_context", &render(&mut a, 100, 28));
}

#[test]
fn narrow_list_and_conversation() {
    let mut a = sample();
    a.focus = Focus::List;
    check("narrow_list", &render(&mut a, 60, 20));
    a.open_chat(0);
    a.mark_read();
    check("narrow_conversation", &render(&mut a, 60, 20));
}

#[test]
fn switcher_popup() {
    let mut a = sample();
    a.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));
    typed(&mut a, "bo");
    check("switcher", &render(&mut a, 90, 24));
}

#[test]
fn help_popup() {
    let mut a = sample();
    a.handle_key(key(KeyCode::F(1)));
    check("help", &render(&mut a, 90, 36));
}

#[test]
fn delete_confirmation() {
    let mut a = sample();
    a.mark_read();
    a.handle_key(key(KeyCode::Esc));
    a.handle_key(key(KeyCode::Char('d')));
    check("confirm_delete", &render(&mut a, 90, 26));
}

#[test]
fn new_chat_popup() {
    let mut a = sample();
    a.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL));
    typed(&mut a, "abc");
    a.handle_key(key(KeyCode::Enter));
    check("new_chat_error", &render(&mut a, 90, 24));
}

#[test]
fn welcome_screen_without_chats() {
    let mut a = app(vec![]);
    check("welcome", &render(&mut a, 90, 22));
}

#[test]
fn sixteen_colours_use_bars_not_fills() {
    let mut a = sample();
    a.theme = Theme::new(ColorMode::Ansi16, &a.cfg.theme);
    a.mark_read();
    check("sixteen_colours", &render(&mut a, 90, 24));
}

#[test]
fn unread_badges_and_drafts_in_the_list() {
    let mut a = sample();
    a.chats[2].composer.set("half written note");
    a.focus = Focus::List;
    let _ = alt;
    check("list_unread_draft", &render(&mut a, 100, 22));
}

#[test]
fn tiny_terminal_does_not_panic() {
    let mut a = sample();
    for (w, h) in [(10, 5), (24, 8), (30, 10), (200, 60)] {
        let _ = render(&mut a, w, h);
    }
}

#[test]
fn header_row_is_filled_edge_to_edge() {
    let mut a = sample();
    let mut term = Terminal::new(TestBackend::new(100, 28)).unwrap();
    term.draw(|f| ui::draw(f, &mut a)).unwrap();
    let buf = term.backend().buffer();
    for y in [0u16, 27] {
        for x in 0..100u16 {
            assert_eq!(buf[(x, y)].bg, a.theme.card, "cell {x},{y}");
        }
    }
}

// ---- M3 screens -----------------------------------------------------------------------------

#[test]
fn link_popup_with_qr() {
    let mut a = sample();
    let url = "https://miga.example/app/#link=G8576A7ENR5M".to_string();
    a.popup = super::app::Popup::Link { code: "G8576A7ENR5M".into(), lines: crate::qr::lines(&url).unwrap(), url };
    check("link_qr", &render(&mut a, 90, 40));
}

#[test]
fn address_is_masked_until_revealed() {
    let mut a = sample();
    a.popup = super::app::Popup::Address;
    let masked = render(&mut a, 90, 24);
    assert!(!masked.contains(&a.me[10..50]), "the middle of the address must not show");
    check("address_masked", &masked);
    a.handle_key(key(KeyCode::Char('r')));
    let shown = render(&mut a, 90, 24);
    assert!(shown.contains(&a.me[..32]));
}

#[test]
fn devices_and_history_banner() {
    let mut a = sample();
    a.my_device = "d".repeat(64);
    a.devices =
        vec![("e".repeat(64), "Android \u{b7} MIGA Mobile".into()), ("f".repeat(64), "Linux \u{b7} MIGA CLI".into())];
    a.history = Some((420, 1000));
    a.popup = super::app::Popup::Devices { sel: 1 };
    check("devices", &render(&mut a, 90, 24));
}

#[test]
fn safety_number_view() {
    let mut a = sample();
    a.popup = super::app::Popup::Safety { peer: ANNA.into() };
    check("safety_unverified", &render(&mut a, 90, 24));
    a.handle_key(key(KeyCode::Char('v')));
    assert!(render(&mut a, 90, 24).contains("Status: Verified"));
}

#[test]
fn search_in_chat_and_global() {
    let mut a = sample();
    a.handle_key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::CONTROL));
    typed(&mut a, "ok");
    check("search_chat", &render(&mut a, 90, 24));
    a.handle_key(key(KeyCode::Esc));
    a.handle_key(alt(KeyCode::Char('f')));
    typed(&mut a, "build");
    check("search_global", &render(&mut a, 90, 24));
    a.handle_key(key(KeyCode::Enter));
    assert_eq!(a.chat().unwrap().name, "Boris");
}

#[test]
fn attachment_bubble_and_mute_marks() {
    let mut photo = msg("p1", false, "look at this", NOW - 5.0 * MIN);
    photo["att"] = json!({"blob":"a".repeat(32),"key":"b".repeat(64),"nonce":"c".repeat(48),"hash":"d".repeat(64),
        "mime":"image/jpeg","size":183_000,"w":1024,"h":768,"thumb":""});
    let mut a = app(vec![seed(ANNA, "Anna", vec![msg("m0", false, "morning!", NOW - 40.0 * MIN), photo])]);
    a.now = NOW;
    a.open_chat(0);
    a.muted = vec![ANNA.into()];
    a.verified = vec![ANNA.into()];
    check("attachment_marks", &render(&mut a, 100, 24));
}

#[test]
fn confirm_delete_chat_command() {
    let mut a = sample();
    a.handle_key(key(KeyCode::Char(':')));
    a.focus = Focus::List;
    a.handle_key(key(KeyCode::Char(':')));
    typed(&mut a, "delete chat");
    a.handle_key(key(KeyCode::Enter));
    check("confirm_delete_chat", &render(&mut a, 90, 24));
    let intents = a.handle_key(key(KeyCode::Char('y')));
    assert!(matches!(intents.first(), Some(super::app::Intent::DeleteChat { .. })));
}

#[test]
fn composer_colon_command_queues_nothing() {
    let mut a;
    for cmd in [":link", ":qr", ":address", ":safety", ":devices", ":search x", ":mute", ":block", ":attach /x.png"] {
        a = sample();
        a.focus = Focus::Composer;
        a.set_composer(cmd);
        let intents = a.handle_key(key(KeyCode::Enter));
        assert!(!intents.iter().any(|i| matches!(i, super::app::Intent::Send { .. })), "{cmd}: {intents:?}");
        assert!(a.composer_text().is_empty(), "{cmd}");
        let screen = render(&mut a, 100, 24);
        assert!(!screen.contains(&format!("You: {cmd}")), "{cmd} shows as a sent message\n{screen}");
    }
    a = sample();
    a.focus = Focus::Composer;
    a.set_composer(":nope");
    assert!(a.handle_key(key(KeyCode::Enter)).is_empty());
    check("composer_unknown_command", &render(&mut a, 100, 24));
}

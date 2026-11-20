//! Offline check of linked-device sync: one account on two stores, no network.
use miga_client::devices::{self, HxRuntime, Keys};
use miga_client::engine::{handle_incoming, prepare_text};
use miga_client::store::Store;
use miga_core::identity::Identity;
use miga_core::sync::{Tomb, TombKind};
use serde_json::{json, Value};

fn temp(tag: &str) -> Store {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let root = std::env::temp_dir().join(format!("miga-devtest-{}-{n}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    Store::in_dirs(root.join("config"), root.join("data"))
}

/// Delivers every queued sync message of `fx` addressed to `to` and returns what `to` wants to send.
fn deliver(store: &Store, keys: &Keys, rt: &mut HxRuntime, from: &Keys, m: &Value) -> devices::Effects {
    let body = from.seal_to(keys.device.address(), m).unwrap();
    devices::handle_sync(store, keys, rt, from.device.address(), &body, 10_000.0).unwrap()
}

struct Pair {
    sa: Store,
    sb: Store,
    ka: Keys,
    kb: Keys,
    peer: Identity,
}

fn pair() -> Pair {
    let (sa, sb) = (temp("a"), temp("b"));
    sa.create_identity(Some("Mira")).unwrap();
    let ka = Keys::load(&sa).unwrap();
    // B joins through a bundle exactly like a real link.
    let offer = devices::new_offer(&sa, &ka).unwrap();
    let derived = miga_core::link::derive_link(&offer.code).unwrap();
    let bundle = miga_core::link::open_value(&derived.bundle_key, &offer.body, "").unwrap();
    assert!(miga_core::link::accept_bundle(&bundle, miga_client::now_ms() as f64));
    devices::adopt_bundle(&sb, &bundle).unwrap();
    let kb = Keys::load(&sb).unwrap();
    assert_eq!(ka.account.address(), kb.account.address());
    assert_ne!(ka.device.address(), kb.device.address());
    // A learns about B from its hello.
    let mut rt = HxRuntime::default();
    let fx = deliver(&sa, &ka, &mut rt, &kb, &json!({"k": "hello", "label": "Linux", "sponsor": ka.device.address()}));
    assert!(fx.notes.contains(&"linked".to_string()));
    let peer = Identity::generate().unwrap();
    Pair { sa, sb, ka, kb, peer }
}

#[test]
fn history_is_pulled_page_by_page_and_resumes() {
    let p = pair();
    let mut rt_a = HxRuntime::default();
    let mut rt_b = HxRuntime::default();
    // 150 messages with long text so the history needs several pages.
    let msgs: Vec<Value> = (0..150)
        .map(|i| {
            json!({"id": format!("m{i:04}"), "mine": i % 2 == 0, "text": "x".repeat(300), "ts": 1000 + i,
                   "state": if i % 2 == 0 {"sent"} else {"received"}})
        })
        .collect();
    p.sa.merge(p.peer.address(), &msgs).unwrap();
    let mut pages = 0;
    loop {
        let (to, q) = devices::hx_query(&p.sb, &p.kb, &mut rt_b, miga_client::now_ms()).unwrap().expect("a request");
        assert_eq!(to, p.ka.device.address());
        let fx = deliver(&p.sa, &p.ka, &mut rt_a, &p.kb, &q);
        let answer = fx.send.iter().find(|(_, m)| m["k"] == "hx").unwrap().1.clone();
        let fx = deliver(&p.sb, &p.kb, &mut rt_b, &p.ka, &answer);
        pages += 1;
        if fx.hx_finished {
            break;
        }
        assert!(pages < 50);
    }
    assert!(pages > 3, "expected several pages, got {pages}");
    assert_eq!(p.sb.chat(p.peer.address()).unwrap().len(), 150);
    assert!(devices::hx_job(&p.sb).is_none());
    assert_eq!(p.sb.contacts().unwrap().len(), 1);
}

#[test]
fn incoming_message_edit_tombstone_and_receipts_reach_the_other_device() {
    let p = pair();
    let (mut rt_a, mut rt_b) = (HxRuntime::default(), HxRuntime::default());
    // The peer writes to the account; A receives it and forwards a copy.
    let out = prepare_text(&temp("peer"), &p.peer, p.ka.account.address(), "hi Mira").unwrap();
    let h = handle_incoming(&p.sa, &p.ka.account, p.peer.address(), &out.id, &out.body, 5000.0).unwrap();
    let copy = h.forward.iter().find(|(_, m)| m["k"] == "msg").expect("msg copy").1.clone();
    deliver(&p.sb, &p.kb, &mut rt_b, &p.ka, &copy);
    assert_eq!(p.sb.chat(p.peer.address()).unwrap().len(), 1);
    assert_eq!(p.sb.contacts().unwrap().len(), 1);

    // Delete the conversation on A; the tombstone empties B and keeps old messages from returning.
    let t = Tomb { chat: p.peer.address().into(), kind: TombKind::Conversation, id: None, mine: false, ts: 9000 };
    let msgs = devices::remember_deletes(&p.sa, std::slice::from_ref(&t)).unwrap();
    devices::apply_tombstones(&p.sa, std::slice::from_ref(&t)).unwrap();
    assert!(p.sa.chat(p.peer.address()).unwrap().is_empty());
    deliver(&p.sb, &p.kb, &mut rt_b, &p.ka, &msgs[0].1);
    assert!(p.sb.chat(p.peer.address()).unwrap().is_empty());
    // A late copy of the old message is dropped; a newer message is not.
    deliver(&p.sb, &p.kb, &mut rt_b, &p.ka, &copy);
    assert!(p.sb.chat(p.peer.address()).unwrap().is_empty());
    let newer = json!({"k": "msg", "peer": p.peer.address(), "message":
        {"id": "new1", "mine": false, "text": "later", "ts": 20_000, "state": "received"}});
    deliver(&p.sb, &p.kb, &mut rt_b, &p.ka, &newer);
    assert_eq!(p.sb.chat(p.peer.address()).unwrap().len(), 1);

    // Edit and read-state sync.
    let edit =
        json!({"k": "edit", "peer": p.peer.address(), "id": "new1", "mine": false, "text": "edited", "ts": 30_000});
    deliver(&p.sb, &p.kb, &mut rt_b, &p.ka, &edit);
    assert_eq!(p.sb.chat(p.peer.address()).unwrap()[0]["text"], "edited");
    let read = json!({"k": "read", "peer": p.peer.address(), "upTo": 20_000});
    let fx = deliver(&p.sb, &p.kb, &mut rt_b, &p.ka, &read);
    assert_eq!(fx.read, vec![(p.peer.address().to_string(), 20_000.0)]);
    let _ = &mut rt_a;
}

#[test]
fn a_foreign_or_wrong_direction_message_is_ignored_and_bye_erases() {
    let p = pair();
    let mut rt = HxRuntime::default();
    let stranger = Keys::load(&{
        let s = temp("stranger");
        s.create_identity(None).unwrap();
        s
    })
    .unwrap();
    let m = json!({"k": "state", "blocked": [p.peer.address()]});
    let body = stranger.seal_to(p.kb.device.address(), &m).unwrap();
    let fx = devices::handle_sync(&p.sb, &p.kb, &mut rt, stranger.device.address(), &body, 1.0).unwrap();
    assert!(fx.send.is_empty() && p.sb.addresses("blocked").is_empty());
    // Replay of A's message to B claimed to come from B itself fails the AAD check.
    let body = p.ka.seal_to(p.kb.device.address(), &m).unwrap();
    let fx = devices::handle_sync(&p.sb, &p.kb, &mut rt, p.kb.device.address(), &body, 1.0).unwrap();
    assert!(p.sb.addresses("blocked").is_empty() && fx.changed.is_empty());
    // A real block list applies; a bye for this device asks for erasure.
    deliver(&p.sb, &p.kb, &mut rt, &p.ka, &m);
    assert_eq!(p.sb.addresses("blocked"), vec![p.peer.address().to_string()]);
    let fx = deliver(&p.sb, &p.kb, &mut rt, &p.ka, &json!({"k": "bye", "address": p.kb.device.address()}));
    assert!(fx.erase);
}

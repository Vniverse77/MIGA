//! Offline end-to-end check of the engine: two identities, two stores, no network.
use miga_client::engine::{delivery_receipt, handle_incoming, prepare_text};
use miga_client::store::Store;
use miga_core::identity::Identity;
use miga_core::payload::{encrypt_delete, encrypt_edit};
use std::path::PathBuf;

fn temp(tag: &str) -> Store {
    let root = std::env::temp_dir().join(format!("miga-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    Store::in_dirs(root.join("config"), root.join("data"))
}

#[test]
fn text_edit_receipt_delete_roundtrip() {
    let (sa, sb) = (temp("a"), temp("b"));
    let (a, b) = (sa.create_identity(Some("Ada")).unwrap(), sb.create_identity(None).unwrap());
    let out = prepare_text(&sa, &a, b.address(), "  hello \u{1F600}  ").unwrap();
    assert_eq!(sa.pending(b.address()).unwrap().len(), 1);

    let h = handle_incoming(&sb, &b, a.address(), &out.id, &out.body, 1000.0).unwrap();
    assert!(h.ack);
    let shown = h.shown.expect("shown");
    assert_eq!((shown.text.as_str(), shown.name.as_str()), ("hello \u{1F600}", "Ada"));
    // Delivering the same message again stores nothing new.
    handle_incoming(&sb, &b, a.address(), &out.id, &out.body, 1000.0).unwrap();
    assert_eq!(sb.chat(a.address()).unwrap().len(), 1);

    // A learns it was delivered.
    let receipt = delivery_receipt(&b, a.address(), std::slice::from_ref(&out.id)).unwrap();
    handle_incoming(&sa, &a, b.address(), "r1", &receipt, 2000.0).unwrap();
    let m = &sa.chat(b.address()).unwrap()[0];
    assert_eq!((m["state"].as_str(), m["delivery"].as_str()), (Some("sent"), Some("delivered")));

    // Edit by the sender applies; the same edit from the wrong side would not.
    let edit = encrypt_edit(&a, b.address(), &out.id, "changed", 5000).unwrap();
    handle_incoming(&sb, &b, a.address(), "e1", &edit, 3000.0).unwrap();
    assert_eq!(sb.chat(a.address()).unwrap()[0]["text"], "changed");

    let del = encrypt_delete(&a, b.address(), std::slice::from_ref(&out.id), 6000).unwrap();
    handle_incoming(&sb, &b, a.address(), "d1", &del, 4000.0).unwrap();
    assert!(sb.chat(a.address()).unwrap().is_empty());

    // Garbage is acknowledged and ignored.
    let junk = handle_incoming(&sb, &b, a.address(), "x", "AAAA", 1.0).unwrap();
    assert!(junk.ack && junk.shown.is_none());
}

#[test]
fn identity_file_is_private_and_never_overwritten() {
    let s = temp("perm");
    let id: Identity = s.create_identity(None).unwrap();
    assert!(s.create_identity(None).is_err());
    assert_eq!(s.identity().unwrap().address(), id.address());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let root: PathBuf = std::env::temp_dir().join(format!("miga-test-{}-perm", std::process::id()));
        let mode = std::fs::metadata(root.join("config/identity.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[test]
fn reply_edit_and_delete_for_everyone_between_two_stores() {
    use miga_client::engine::{
        apply_own_delete, apply_own_edit, prepare_delete, prepare_edit, prepare_message, reseal_pending, seen_receipt,
    };
    use miga_core::payload::Reply;
    let (sa, sb) = (temp("c"), temp("d"));
    let (a, b) = (sa.create_identity(Some("Ada")).unwrap(), sb.create_identity(None).unwrap());

    // B sends a first message, A replies to it.
    let first = prepare_message(&sb, &b, a.address(), "where?", None).unwrap();
    handle_incoming(&sa, &a, b.address(), &first.id, &first.body, 1000.0).unwrap();
    let quote = Reply { id: first.id.clone(), from: b.address().into(), text: "where?".into() };
    let out = prepare_message(&sa, &a, b.address(), "at the cafe", Some(&quote)).unwrap();
    let h = handle_incoming(&sb, &b, a.address(), &out.id, &out.body, 2000.0).unwrap();
    assert_eq!(h.shown.unwrap().text, "at the cafe");
    let got = sb.chat(a.address()).unwrap();
    let theirs = got.iter().find(|m| m["id"] == out.id.as_str()).unwrap();
    assert_eq!(theirs["reply"]["text"], "where?");

    // The stored reply survives a resend of a pending message.
    let pending = sa.pending(b.address()).unwrap();
    let again = reseal_pending(&sa, &a, b.address(), &pending[0]).unwrap();
    let h2 = handle_incoming(&sb, &b, a.address(), &again.id, &again.body, 2500.0).unwrap();
    assert!(h2.shown.is_none(), "same id is deduplicated");

    // Edit: validated, applied locally after the relay confirmed, then applied by the peer.
    assert!(prepare_edit(&a, b.address(), &out.id, "   ").is_err());
    let edit = prepare_edit(&a, b.address(), &out.id, "  at the old cafe ").unwrap();
    assert_eq!(edit.text, "at the old cafe");
    assert!(apply_own_edit(&sa, b.address(), &out.id, &edit.text, edit.ts).unwrap());
    handle_incoming(&sb, &b, a.address(), &edit.frame_id, &edit.body, 3000.0).unwrap();
    let theirs = sb.chat(a.address()).unwrap().into_iter().find(|m| m["id"] == out.id.as_str()).unwrap();
    assert_eq!(theirs["text"], "at the old cafe");
    let mine = sa.chat(b.address()).unwrap().into_iter().find(|m| m["id"] == out.id.as_str()).unwrap();
    assert!(mine["edited"].as_f64().unwrap() > 0.0);

    // Read receipt reaches the author.
    let seen = seen_receipt(&b, a.address(), std::slice::from_ref(&out.id)).unwrap();
    handle_incoming(&sa, &a, b.address(), "s1", &seen, 3500.0).unwrap();
    let mine = sa.chat(b.address()).unwrap().into_iter().find(|m| m["id"] == out.id.as_str()).unwrap();
    assert_eq!(mine["delivery"], "read");

    // Delete for everyone.
    let del = prepare_delete(&a, b.address(), &out.id).unwrap();
    assert!(apply_own_delete(&sa, b.address(), &out.id).unwrap());
    handle_incoming(&sb, &b, a.address(), &del.frame_id, &del.body, 4000.0).unwrap();
    assert_eq!(sb.chat(a.address()).unwrap().len(), 1);
    assert_eq!(sa.chat(b.address()).unwrap().len(), 1);
}

#[test]
fn ui_lock_is_exclusive_and_state_roundtrips() {
    let s = temp("lock");
    let held = s.lock_ui().unwrap().expect("first lock");
    assert!(s.ui_running());
    assert!(s.lock_ui().unwrap().is_none());
    drop(held);
    assert!(!s.ui_running());
    s.save_ui_state(&serde_json::json!({"read": {"x": 5.0}})).unwrap();
    assert_eq!(s.ui_state()["read"]["x"], 5.0);
}

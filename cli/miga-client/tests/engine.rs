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

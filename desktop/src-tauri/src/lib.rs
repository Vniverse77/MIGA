// The desktop app is a thin shell: it shows the same web interface that the relay serves, but
// the files come from inside the package. Nothing is downloaded at start, so whoever controls
// a server cannot swap the app's code. No Rust command is exposed to the page.
//
// Native extras: a save dialog for key backups (dialog + fs plugins, desktop only), local notifications (official plugin; the page decides when to show one)
// and a tray icon. Closing the window hides it to the tray so the relay connection stays alive;
// "Quit" in the tray menu ends the app. If the tray cannot be created (no status-area support),
// closing the window quits as before, so the app is never left running without a way back.
// Also on desktop: single instance and remembered window size/position (official plugins).
// Tray and close-to-tray are desktop only; on Android the system owns the window lifecycle.
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

#[cfg(desktop)]
static TRAY_READY: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Single instance must be the first plugin: a second launch shows the running window and exits.
    // Window state remembers size, position and maximized between runs (closing hides to the tray,
    // and the plugin also saves on quit); the 800x560 minimum comes from tauri.conf.json.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Only for saving a key backup: the person picks the file in a native dialog, which is the only
        // path the page may then write (the fs plugin starts with an empty scope).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());
    let builder = builder.plugin(tauri_plugin_notification::init());
    #[cfg(desktop)]
    let builder = builder
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show MIGA", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("MIGA")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            match tray.build(app) {
                Ok(_) => TRAY_READY.store(true, Ordering::SeqCst),
                Err(error) => eprintln!("MIGA: no tray icon, closing the window quits: {error}"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if TRAY_READY.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
    builder
        .run(tauri::generate_context!())
        .expect("error while running MIGA");
}

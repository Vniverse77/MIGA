// The desktop app is a thin shell: it shows the same web interface that the relay serves, but
// the files come from inside the package. Nothing is downloaded at start, so whoever controls
// a server cannot swap the app's code.
//
// Native extras: a save dialog for key backups (dialog + fs plugins, desktop only), local notifications
// (official plugin; the page decides when to show one) and a tray icon. Closing the window hides it to the
// tray so the relay connection stays alive (setting "Keep running in the tray when closed", default on);
// "Quit MIGA" in the tray menu ends the app. If the tray cannot be created (appindicator library missing,
// no status-area host on the session bus), closing the window quits as before, so the app is never left
// running without a way back. Also on desktop: single instance and remembered window size/position.
// Tray and close-to-tray are desktop only; on Android the system owns the window lifecycle.
//
// The page may call four small commands (tray_state, set_keep_in_tray, set_notify, set_unread). They carry
// booleans and one number; nothing else crosses from the page to the shell.
#[cfg(desktop)]
mod shell {
    use serde::{Deserialize, Serialize};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    use tauri::{
        image::Image,
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        AppHandle, Emitter, Manager, WindowEvent,
    };

    /// True once a tray icon was created AND something can show it.
    static TRAY_READY: AtomicBool = AtomicBool::new(false);

    #[derive(Clone, Copy, Serialize, Deserialize)]
    #[serde(default)]
    pub struct Prefs {
        /// Closing the window hides it to the tray instead of quitting.
        pub keep: bool,
        /// Native notifications for new messages (the tray menu toggles it too).
        pub notify: bool,
    }
    impl Default for Prefs {
        fn default() -> Self {
            Prefs { keep: true, notify: true }
        }
    }

    pub struct Shared {
        prefs: Mutex<Prefs>,
        toggle: Mutex<Option<MenuItem<tauri::Wry>>>,
        base_icon: Mutex<Option<Image<'static>>>,
    }

    #[derive(Serialize, Clone, Copy)]
    pub struct TrayState {
        tray: bool,
        keep: bool,
        notify: bool,
    }

    fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
        app.path().app_config_dir().ok().map(|d| d.join("prefs.json"))
    }

    fn load_prefs(app: &AppHandle) -> Prefs {
        prefs_path(app)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save_prefs(app: &AppHandle, prefs: Prefs) {
        if let Some(path) = prefs_path(app) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(bytes) = serde_json::to_vec(&prefs) {
                let _ = std::fs::write(path, bytes);
            }
        }
    }

    pub fn show_main(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }

    fn toggle_main(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
                let _ = window.hide();
            } else {
                show_main(app);
            }
        }
    }

    fn state_of(app: &AppHandle) -> TrayState {
        let prefs = *app.state::<Shared>().prefs.lock().unwrap();
        TrayState { tray: TRAY_READY.load(Ordering::SeqCst), keep: prefs.keep, notify: prefs.notify }
    }

    fn sync_menu(app: &AppHandle) {
        let shared = app.state::<Shared>();
        let notify = shared.prefs.lock().unwrap().notify;
        if let Some(item) = shared.toggle.lock().unwrap().as_ref() {
            let _ = item.set_text(if notify { "Disable notifications" } else { "Enable notifications" });
        }
        let _ = app.emit("miga-prefs", state_of(app));
    }

    fn set_notify_inner(app: &AppHandle, on: bool) {
        let shared = app.state::<Shared>();
        let prefs = {
            let mut guard = shared.prefs.lock().unwrap();
            guard.notify = on;
            *guard
        };
        save_prefs(app, prefs);
        sync_menu(app);
    }

    #[tauri::command]
    pub fn tray_state(app: AppHandle) -> TrayState {
        state_of(&app)
    }

    #[tauri::command]
    pub fn set_keep_in_tray(app: AppHandle, keep: bool) {
        let shared = app.state::<Shared>();
        let prefs = {
            let mut guard = shared.prefs.lock().unwrap();
            guard.keep = keep;
            *guard
        };
        save_prefs(&app, prefs);
    }

    #[tauri::command]
    pub fn set_notify(app: AppHandle, notify: bool) {
        set_notify_inner(&app, notify);
    }

    /// The page reports the unread total (muted chats excluded): a dot on the icon and a tooltip.
    #[tauri::command]
    pub fn set_unread(app: AppHandle, count: u32) {
        let Some(tray) = app.tray_by_id("main") else { return };
        let _ = tray.set_tooltip(Some(if count == 0 {
            "MIGA".to_string()
        } else {
            format!("MIGA - {count} unread")
        }));
        let base = app.state::<Shared>().base_icon.lock().unwrap().clone();
        if let Some(base) = base {
            let icon = if count == 0 { base } else { with_dot(&base) };
            let _ = tray.set_icon(Some(icon));
        }
    }

    /// A red dot in the top-right corner of the icon.
    fn with_dot(base: &Image<'static>) -> Image<'static> {
        let (w, h) = (base.width() as i64, base.height() as i64);
        let mut rgba = base.rgba().to_vec();
        let radius = (w.min(h) as f64 * 0.24).max(3.0);
        let (cx, cy) = (w as f64 - radius - 1.0, radius + 1.0);
        for y in 0..h {
            for x in 0..w {
                let d = (((x as f64 + 0.5) - cx).powi(2) + ((y as f64 + 0.5) - cy).powi(2)).sqrt();
                let i = ((y * w + x) * 4) as usize;
                if d <= radius {
                    rgba[i..i + 4].copy_from_slice(&[0xe5, 0x39, 0x35, 0xff]);
                } else if d <= radius + 1.5 {
                    // a thin light ring so the dot reads on dark and light panels
                    rgba[i..i + 4].copy_from_slice(&[0xff, 0xff, 0xff, 0xff]);
                }
            }
        }
        Image::new_owned(rgba, base.width(), base.height())
    }

    /// Linux only: can a tray icon be created at all, and will something show it? Both checks are
    /// done up front because the tray library panics (and the release build aborts) when the
    /// appindicator library is missing, and an icon nobody displays would leave a hidden window.
    #[cfg(target_os = "linux")]
    fn tray_supported() -> Result<(), String> {
        let found = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
            .iter()
            .any(|name| unsafe { libloading::Library::new(name) }.is_ok());
        if !found {
            return Err("libayatana-appindicator3 is not installed".into());
        }
        let host = (|| -> Result<bool, zbus::Error> {
            let conn = zbus::blocking::Connection::session()?;
            let bus = zbus::blocking::fdo::DBusProxy::new(&conn)?;
            for name in ["org.kde.StatusNotifierWatcher", "org.freedesktop.StatusNotifierWatcher"] {
                if bus.name_has_owner(zbus::names::BusName::try_from(name)?)? {
                    return Ok(true);
                }
            }
            Ok(false)
        })();
        match host {
            Ok(true) => Ok(()),
            Ok(false) => Err("no status-area host (StatusNotifierWatcher) on the session bus".into()),
            Err(e) => Err(format!("session bus not reachable: {e}")),
        }
    }
    #[cfg(not(target_os = "linux"))]
    fn tray_supported() -> Result<(), String> {
        Ok(())
    }

    pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
        let handle = app.handle().clone();
        let prefs = load_prefs(&handle);
        app.manage(Shared {
            prefs: Mutex::new(prefs),
            toggle: Mutex::new(None),
            base_icon: Mutex::new(app.default_window_icon().map(|i| i.clone().to_owned())),
        });
        if let Err(reason) = tray_supported() {
            eprintln!("MIGA: no tray icon, closing the window quits: {reason}");
            return Ok(());
        }
        let open = MenuItem::with_id(app, "show", "Open MIGA", true, None::<&str>)?;
        let toggle = MenuItem::with_id(
            app,
            "notify",
            if prefs.notify { "Disable notifications" } else { "Enable notifications" },
            true,
            None::<&str>,
        )?;
        let quit = MenuItem::with_id(app, "quit", "Quit MIGA", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &toggle, &quit])?;
        *app.state::<Shared>().toggle.lock().unwrap() = Some(toggle);
        let mut tray = TrayIconBuilder::with_id("main")
            .tooltip("MIGA")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => show_main(app),
                "notify" => {
                    let now = app.state::<Shared>().prefs.lock().unwrap().notify;
                    set_notify_inner(app, !now);
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                // Windows and macOS report clicks; on Linux the status area opens the menu instead.
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    toggle_main(tray.app_handle());
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
    }

    pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let keep = window.app_handle().state::<Shared>().prefs.lock().unwrap().keep;
            if TRAY_READY.load(Ordering::SeqCst) && keep {
                api.prevent_close();
                let _ = window.hide();
                eprintln!("MIGA: window hidden to the tray");
            }
        }
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Only for saving a key backup: the person picks the file in a native dialog, which is the only
        // path the page may then write (the fs plugin starts with an empty scope).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());
    // Copy and paste go through the system clipboard, because the web clipboard API is unreliable in WebKitGTK and the Android WebView.
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(desktop)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            shell::tray_state,
            shell::set_keep_in_tray,
            shell::set_notify,
            shell::set_unread
        ])
        .setup(shell::setup)
        .on_window_event(|window, event| shell::on_window_event(window, event));
    builder
        .run(tauri::generate_context!())
        .expect("error while running MIGA");
}

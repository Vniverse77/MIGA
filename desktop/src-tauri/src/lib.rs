// The desktop app is a thin shell: it shows the same web interface that the relay serves, but
// the files come from inside the package. Nothing is downloaded at start, so whoever controls
// a server cannot swap the app's code. No Rust command is exposed to the page.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running MIGA");
}

//! The Glade iPhone app's native shell (docs/design/iphone-app.md §4.2): a single WebView with
//! the phone layout (apps/iphone/src). No server, tray or menus: the app is a pure client of the
//! user's Macs. Native bits: the Keychain for device tokens (secrets.rs) and the camera for scanning
//! a Mac's pairing QR code (tauri-plugin-barcode-scanner, mobile only; used by src/lib/scan.ts).

mod secrets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .invoke_handler(tauri::generate_handler![secrets::secret_get, secrets::secret_set, secrets::secret_delete])
        .run(tauri::generate_context!())
        .expect("error while running the Glade iPhone app");
}

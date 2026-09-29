//! The Glade iPhone app's native shell (docs/design/iphone-app.md §4.2): a single WebView with
//! the phone layout (apps/iphone/src). No server, tray or menus: the app is a pure client of the
//! user's Macs. Native bits: the Keychain for device tokens (secrets.rs).

mod secrets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![secrets::secret_get, secrets::secret_set, secrets::secret_delete])
        .run(tauri::generate_context!())
        .expect("error while running the Glade iPhone app");
}

//! The Glade iPhone app's native shell (docs/design/iphone-app.md §4.2): a single WebView with
//! the phone layout (apps/iphone/src). No server, tray or menus: the app is a pure client of the
//! user's Macs. Native bits: the Keychain for device tokens (secrets.rs) and the camera for scanning
//! a Mac's pairing QR code (tauri-plugin-barcode-scanner, mobile only; used by src/lib/scan.ts),
//! and no form accessory bar over the keyboard (keyboard_bar.rs). Conversation mode (I-180) uses
//! the `voice` plugin (plugins/voice: a Swift Tauri plugin; src/voice/native-engine.ts).
//!
//! Debug builds only: launched with `--glade-fake-voice` (e.g. `xcrun simctl launch booted <id>
//! --glade-fake-voice`), the page gets `window.__GLADE_FAKE_VOICE__` and uses the fake voice engine,
//! because on-device speech recognition doesn't start in the iOS simulator (website captures, I-209).

mod secrets;
#[cfg(target_os = "ios")]
mod keyboard_bar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_voice::init());
    #[cfg(debug_assertions)]
    let builder = if std::env::args().any(|a| a == "--glade-fake-voice") {
        builder.plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("glade-fake-voice")
                .js_init_script("window.__GLADE_FAKE_VOICE__ = true;".to_string())
                .build(),
        )
    } else {
        builder
    };
    builder
        .setup(|_app| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| unsafe { keyboard_bar::hide(webview.inner().cast()) });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![secrets::secret_get, secrets::secret_set, secrets::secret_delete])
        .run(tauri::generate_context!())
        .expect("error while running the Glade iPhone app");
}

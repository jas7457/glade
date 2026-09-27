//! Keep `tauri dev` builds apart from the installed app.
//!
//! - Own identifier (`io.github.jas7457.pi-ui.dev`). The single-instance plugin keys its socket on the
//!   identifier, so with a shared one, opening /Applications/pi-ui.app while `tauri dev` runs just
//!   focused the dev window and exited (the switcher then showed the dev binary). It also gives dev
//!   its own window state / app dirs. Matches the bundle id `scripts/dev-app-runner.sh` writes.
//!   `PI_UI_APP_IDENTIFIER=<id>` overrides it for any build (agents testing a release build while
//!   the installed app runs, with `PI_UI_DATA_DIR` pointing at a temp folder).
//! - Dock icon: in dev, Tauri replaces the Dock icon with `icons/icon.icns` at startup. When we run
//!   inside the runner's "pi-ui (dev).app" we reset it so the Dock shows the bundle's DEV icon, the
//!   same one the app switchers read from the bundle.

use tauri::Context;

pub const IDENTIFIER: &str = "io.github.jas7457.pi-ui.dev";

/// Env var that gives a build another identifier at launch (testing a release build next to the
/// installed app: the single-instance socket, window state and log dir are keyed on it).
pub const IDENTIFIER_ENV: &str = "PI_UI_APP_IDENTIFIER";

/// Call on the generated context before building the app.
pub fn adjust_context<R: tauri::Runtime>(context: &mut Context<R>) {
    if let Some(id) = std::env::var(IDENTIFIER_ENV).ok().filter(|id| !id.is_empty()) {
        context.config_mut().identifier = id;
    } else if tauri::is_dev() {
        context.config_mut().identifier = IDENTIFIER.into();
    }
}

/// Call on `RunEvent::Ready` (after Tauri set its dev Dock icon).
pub fn on_ready() {
    #[cfg(target_os = "macos")]
    if tauri::is_dev() && in_app_bundle() {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            // nil restores the bundle's own icon (CFBundleIconFile).
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![ns_app, setApplicationIconImage: nil];
        }
    }
}

#[cfg(target_os = "macos")]
fn in_app_bundle() -> bool {
    std::env::current_exe().is_ok_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
}

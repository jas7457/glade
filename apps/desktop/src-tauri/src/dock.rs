//! The Dock icon (I-150): the app's activation policy.
//!
//! - Regular (Dock icon + menu bar) while "Show in Dock" is on and Glade isn't closed to the menu
//!   bar; the red close button only hides the window, so the Dock icon stays (like Mail).
//! - Accessory (menu bar icon only) after ⌘Q closed it to the menu bar, and always when "Show in
//!   Dock" is off (like Tailscale, also with its window open).
//! - Reopening (menu bar, Dock/Spotlight launch, a notification click) leaves "closed to the menu
//!   bar" and brings the Dock icon back if "Show in Dock" is on.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

/// Glade was closed to the menu bar (⌘Q with "quitToMenuBar") and not reopened since.
static IN_MENU_BAR: AtomicBool = AtomicBool::new(false);

/// Pure: should the Dock icon show?
pub fn wants_dock_icon(show_in_dock: bool, in_menu_bar: bool) -> bool {
    show_in_dock && !in_menu_bar
}

pub fn in_menu_bar() -> bool {
    IN_MENU_BAR.load(Ordering::SeqCst)
}

pub fn set_in_menu_bar(on: bool, app: &AppHandle) {
    IN_MENU_BAR.store(on, Ordering::SeqCst);
    apply(app);
}

/// Apply the policy for the current prefs and state.
pub fn apply(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let dock = wants_dock_icon(crate::prefs::get(app).show_in_dock, in_menu_bar());
        let policy = if dock { ActivationPolicy::Regular } else { ActivationPolicy::Accessory };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Bring the app to the front (after the policy changed, the menu bar only shows once activated).
pub fn activate(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(|| unsafe {
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dock_icon_rules() {
        assert!(wants_dock_icon(true, false));
        assert!(!wants_dock_icon(true, true), "closed to the menu bar");
        assert!(!wants_dock_icon(false, false), "Show in Dock off: menu bar only, window or not");
        assert!(!wants_dock_icon(false, true));
    }
}

//! The menu bar icon (I-150): Glade's leaf as a template image (one icon, no status badges), and a menu:
//!
//!   N chats working            (opens one)        ← from the server (`shell_state.rs`)
//!   N chats need you           (opens one)
//!   ─────
//!   ✓ Sharing: on · iPhone connected              (toggles sharing)
//!   ─────
//!   Open Glade                                    (the window, at the screen it was on)
//!   New Chat
//!   Settings…
//!   ─────
//!   Keeping this Mac awake: 2 chats are working   (I-147, info only)
//!   ─────
//!   Quit Glade Completely                         (with the running-chats check)
//!
//! `menu_model` is pure (tested); `refresh` rebuilds the native menu from them.
//! Clicks arrive through the app-wide menu handler (`menu::handle` → `handle`, ids `tray-*`).

use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

use crate::menu::MENU_EVENT;
use crate::shell_state::{self, ShellState};
use crate::{focus_main, MAIN_WINDOW};

const TRAY_ID: &str = "glade";
pub const WORKING: &str = "tray-working";
pub const NEEDS_YOU: &str = "tray-needs-you";
pub const SHARING: &str = "tray-sharing";
pub const OPEN: &str = "tray-open";
pub const NEW_CHAT: &str = "tray-new-chat";
pub const SETTINGS: &str = "tray-settings";
pub const AWAKE: &str = "tray-awake";
pub const QUIT: &str = "tray-quit";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayItem {
    Action { id: &'static str, label: String, enabled: bool },
    Check { id: &'static str, label: String, checked: bool },
    Separator,
}

fn chats(n: u32, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 chat {one}")
    } else {
        format!("{n} chats {many}")
    }
}

fn devices_text(devices: &[String]) -> String {
    match devices {
        [] => String::new(),
        [one] => format!("{one} connected"),
        [a, b] => format!("{a} and {b} connected"),
        [first, rest @ ..] => format!("{first} and {} others connected", rest.len()),
    }
}

/// The menu for a state (`None`: the server isn't answering yet).
pub fn menu_model(state: Option<&ShellState>) -> Vec<TrayItem> {
    let mut items = Vec::new();
    if let Some(s) = state {
        items.push(if s.working > 0 {
            TrayItem::Action { id: WORKING, label: chats(s.working, "working", "working"), enabled: true }
        } else {
            TrayItem::Action { id: WORKING, label: "No chats working".into(), enabled: false }
        });
        if s.needs_you > 0 {
            items.push(TrayItem::Action { id: NEEDS_YOU, label: chats(s.needs_you, "needs you", "need you"), enabled: true });
        }
        items.push(TrayItem::Separator);
        let label = if !s.sharing_on {
            "Sharing: off".to_string()
        } else if s.devices.is_empty() {
            "Sharing: on".to_string()
        } else {
            format!("Sharing: on · {}", devices_text(&s.devices))
        };
        items.push(TrayItem::Check { id: SHARING, label, checked: s.sharing_on });
        items.push(TrayItem::Separator);
    }
    items.push(TrayItem::Action { id: OPEN, label: "Open Glade".into(), enabled: true });
    items.push(TrayItem::Action { id: NEW_CHAT, label: "New Chat".into(), enabled: true });
    items.push(TrayItem::Action { id: SETTINGS, label: "Settings…".into(), enabled: true });
    if let Some(s) = state.filter(|s| s.held && !s.awake_text.is_empty()) {
        items.push(TrayItem::Separator);
        items.push(TrayItem::Action { id: AWAKE, label: format!("Keeping this Mac awake: {}", s.awake_text), enabled: false });
    }
    items.push(TrayItem::Separator);
    items.push(TrayItem::Action { id: QUIT, label: "Quit Glade Completely".into(), enabled: true });
    items
}

/// The menu bar icon: Glade's leaf (a template image, so macOS tints it for light/dark menu bars).
fn icon() -> Image<'static> {
    tauri::include_image!("icons/tray/tray-idle.png")
}

fn build_menu(app: &AppHandle, items: &[TrayItem]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for item in items {
        match item {
            TrayItem::Action { id, label, enabled } => menu.append(&MenuItemBuilder::with_id(*id, label).enabled(*enabled).build(app)?)?,
            TrayItem::Check { id, label, checked } => menu.append(&CheckMenuItemBuilder::with_id(*id, label).checked(*checked).build(app)?)?,
            TrayItem::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(menu)
}

/// Create the menu bar icon. Call once from `setup`.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, &menu_model(None))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon())
        .icon_as_template(true)
        .tooltip("Glade")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

/// Rebuild the icon and menu from the latest state (any thread).
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = handle.tray_by_id(TRAY_ID) else { return };
        let state = shell_state::current();
        if let Ok(menu) = build_menu(&handle, &menu_model(state.as_ref())) {
            let _ = tray.set_menu(Some(menu));
        }
        let tooltip = match state.as_ref().filter(|s| s.held && !s.awake_text.is_empty()) {
            Some(s) => format!("Glade — keeping this Mac awake: {}", s.awake_text),
            None => "Glade".to_string(),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    });
}

/// A tray menu click. Returns false for ids that aren't ours.
pub fn handle(app: &AppHandle, id: &str) -> bool {
    match id {
        WORKING => open_with(app, "show-working"),
        NEEDS_YOU => open_with(app, "show-needs-you"),
        OPEN => focus_main(app),
        NEW_CHAT => open_with(app, "new-chat"),
        SETTINGS => open_with(app, "settings"),
        SHARING => toggle_sharing(app),
        QUIT => crate::quit::quit_completely(app),
        AWAKE => {}
        _ => return false,
    }
    true
}

fn open_with(app: &AppHandle, action: &str) {
    focus_main(app);
    let _ = app.emit_to(MAIN_WINDOW, MENU_EVENT, action);
}

/// Flip the host switch (`PATCH /api/auth/remote`); if that fails (e.g. Tailscale isn't set up),
/// open Settings → Remote Access, which says why.
fn toggle_sharing(app: &AppHandle) {
    let Some(state) = shell_state::current() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let body = format!("{{\"enabled\":{}}}", !state.sharing_on);
        let ok = shell_state::server_target(&app)
            .and_then(|(host, port)| crate::server::http_request(&host, port, "PATCH", "/api/auth/remote", Some(&body), Duration::from_secs(20)))
            .is_some();
        if !ok || (!state.sharing_on && !shell_state::sharing_now(&app)) {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || open_with(&handle, "remote-settings"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(working: u32, needs_you: u32, sharing_on: bool, devices: &[&str], held: bool, awake: &str) -> ShellState {
        ShellState {
            rev: 1,
            working,
            needs_you,
            sharing_on,
            devices: devices.iter().map(|d| d.to_string()).collect(),
            held,
            awake_text: awake.into(),
        }
    }

    fn labels(items: &[TrayItem]) -> Vec<String> {
        items
            .iter()
            .map(|i| match i {
                TrayItem::Action { label, enabled, .. } => format!("{label}{}", if *enabled { "" } else { " (disabled)" }),
                TrayItem::Check { label, checked, .. } => format!("{}{label}", if *checked { "✓ " } else { "" }),
                TrayItem::Separator => "—".into(),
            })
            .collect()
    }

    #[test]
    fn menu_before_the_server_answers() {
        assert_eq!(labels(&menu_model(None)), ["Open Glade", "New Chat", "Settings…", "—", "Quit Glade Completely"]);
    }

    #[test]
    fn menu_idle_and_busy() {
        let idle = state(0, 0, false, &[], false, "");
        assert_eq!(
            labels(&menu_model(Some(&idle))),
            ["No chats working (disabled)", "—", "Sharing: off", "—", "Open Glade", "New Chat", "Settings…", "—", "Quit Glade Completely"]
        );
        let busy = state(2, 1, true, &["iPhone"], true, "2 chats are working · iPhone is connected");
        assert_eq!(
            labels(&menu_model(Some(&busy))),
            [
                "2 chats working",
                "1 chat needs you",
                "—",
                "✓ Sharing: on · iPhone connected",
                "—",
                "Open Glade",
                "New Chat",
                "Settings…",
                "—",
                "Keeping this Mac awake: 2 chats are working · iPhone is connected (disabled)",
                "—",
                "Quit Glade Completely",
            ]
        );
        let shared = state(1, 0, true, &["iPad", "iPhone", "Mac mini"], false, "");
        let l = labels(&menu_model(Some(&shared)));
        assert_eq!(l[0], "1 chat working");
        assert_eq!(l[2], "✓ Sharing: on · iPad and 2 others connected");
        assert!(!l.iter().any(|s| s.starts_with("Keeping")), "not held: no awake line");
    }
}

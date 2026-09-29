//! The menu bar icon (I-150): Glade's leaf as a template image, with a small badge while chats are
//! working (ring) or need you (dot); no sharing mark (the user found the arcs confusing). The menu:
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
//! `menu_model` and `icon_name` are pure (tested); `refresh` rebuilds the native menu from them.
//! Clicks arrive through the app-wide menu handler (`menu::handle` → `handle`, ids `tray-*`).

use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

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

/// Icon file stem (icons/tray/tray-<name>.png): needs you > working > idle.
pub fn icon_name(state: Option<&ShellState>) -> &'static str {
    match state {
        Some(s) if s.needs_you > 0 => "needs",
        Some(s) if s.working > 0 => "working",
        _ => "idle",
    }
}

/// Template images, so macOS tints them for light/dark menu bars.
fn icon(name: &str) -> Image<'static> {
    match name {
        "needs" => tauri::include_image!("icons/tray/tray-needs.png"),
        "working" => tauri::include_image!("icons/tray/tray-working.png"),
        _ => tauri::include_image!("icons/tray/tray-idle.png"),
    }
}

fn build_menu(app: &AppHandle, items: &[TrayItem]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    append_items(app, &menu, items)?;
    Ok(menu)
}

fn append_items(app: &AppHandle, menu: &Menu<tauri::Wry>, items: &[TrayItem]) -> tauri::Result<()> {
    for item in items {
        match item {
            TrayItem::Action { id, label, enabled } => menu.append(&MenuItemBuilder::with_id(*id, label).enabled(*enabled).build(app)?)?,
            TrayItem::Check { id, label, checked } => menu.append(&CheckMenuItemBuilder::with_id(*id, label).checked(*checked).build(app)?)?,
            TrayItem::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(())
}

/// The tray's one menu and the model it shows. Updates change it in place: replacing the menu
/// (`set_menu`) closes it while it's open, e.g. when a chat finishes as you look at it.
struct TrayMenu {
    menu: Menu<tauri::Wry>,
    shown: Mutex<Vec<TrayItem>>,
}

/// Same items in the same order (only labels / enabled / checked may differ).
fn same_shape(a: &[TrayItem], b: &[TrayItem]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| match (x, y) {
            (TrayItem::Action { id: i, .. }, TrayItem::Action { id: j, .. }) => i == j,
            (TrayItem::Check { id: i, .. }, TrayItem::Check { id: j, .. }) => i == j,
            (TrayItem::Separator, TrayItem::Separator) => true,
            _ => false,
        })
}

/// Bring the open-or-closed menu up to date without replacing it.
fn update_menu(app: &AppHandle, tray_menu: &TrayMenu, next: Vec<TrayItem>) -> tauri::Result<()> {
    let mut shown = tray_menu.shown.lock().unwrap_or_else(|e| e.into_inner());
    if *shown == next {
        return Ok(());
    }
    if same_shape(&shown, &next) {
        for (item, kind) in next.iter().zip(tray_menu.menu.items()?) {
            match (item, kind) {
                (TrayItem::Action { label, enabled, .. }, MenuItemKind::MenuItem(m)) => {
                    m.set_text(label)?;
                    m.set_enabled(*enabled)?;
                }
                (TrayItem::Check { label, checked, .. }, MenuItemKind::Check(m)) => {
                    m.set_text(label)?;
                    m.set_checked(*checked)?;
                }
                _ => {}
            }
        }
    } else {
        while tray_menu.menu.remove_at(0)?.is_some() {}
        append_items(app, &tray_menu.menu, &next)?;
    }
    *shown = next;
    Ok(())
}

/// Create the menu bar icon. Call once from `setup`.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let model = menu_model(None);
    let menu = build_menu(app, &model)?;
    app.manage(TrayMenu { menu: menu.clone(), shown: Mutex::new(model) });
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon("idle"))
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
        let _ = tray.set_icon(Some(icon(icon_name(state.as_ref()))));
        let _ = tray.set_icon_as_template(true);
        if let Some(tray_menu) = handle.try_state::<TrayMenu>() {
            let _ = update_menu(&handle, &tray_menu, menu_model(state.as_ref()));
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

    #[test]
    fn icon_states() {
        assert_eq!(icon_name(None), "idle");
        assert_eq!(icon_name(Some(&state(0, 0, false, &[], false, ""))), "idle");
        assert_eq!(icon_name(Some(&state(0, 0, true, &[], false, ""))), "idle", "sharing has no mark");
        assert_eq!(icon_name(Some(&state(1, 0, true, &[], false, ""))), "working");
        assert_eq!(icon_name(Some(&state(1, 1, false, &[], false, ""))), "needs");
    }

    #[test]
    fn updates_in_place_when_only_labels_change() {
        let a = menu_model(Some(&state(1, 0, true, &[], false, "")));
        let b = menu_model(Some(&state(3, 0, false, &["iPad"], false, "")));
        assert!(same_shape(&a, &b), "counts and sharing text change in place");
        let c = menu_model(Some(&state(1, 1, true, &[], false, "")));
        assert!(!same_shape(&a, &c), "a new 'needs you' line changes the shape");
        assert!(!same_shape(&menu_model(None), &a));
    }
}

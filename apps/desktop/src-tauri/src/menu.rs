//! The macOS menu bar. Standard items (Edit, Minimize, Quit…) are predefined native items; the
//! app-specific ones are forwarded to the web app as a `glade:menu` event whose payload is the
//! item id (`new-chat`, `settings`, `toggle-sidebar`, `command-palette`, and the tab items
//! `new-tab`, `new-terminal`, `close-tab`, `next-tab`, `previous-tab`); the web app maps them in
//! `apps/web/src/app/shortcuts.ts` (`MENU_ACTIONS`, `useTabShortcuts`, `useNewTerminalMenu`).
//!
//! File → New Terminal (⌃`, I-192) is only enabled while a chat is open: the web app says so
//! with the `menu_chat_open` command.
//!
//! ⌘W closes the current tab, so Close Window is our own item on ⇧⌘W (the predefined one is
//! hard-wired to ⌘W).
//!
//! Quit is ours too (I-150): "Quit Glade" (⌘Q) closes to the menu bar when that setting is on,
//! "Quit Glade Completely" (⌥⌘Q) always quits (`quit.rs`). Menu bar (tray) clicks come here as
//! well and go to `tray::handle`.

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::{focus_main, MAIN_WINDOW};

pub const MENU_EVENT: &str = "glade:menu";
const CLOSE_WINDOW: &str = "close-window";
const QUIT: &str = "quit";
const QUIT_COMPLETELY: &str = "quit-completely";
/// Items that (show and) act on the main window.
const APP_ACTIONS: [&str; 6] = ["new-chat", "settings", "toggle-sidebar", "command-palette", "new-tab", NEW_TERMINAL];
const NEW_TERMINAL: &str = "new-terminal";

/// Menu items whose state the web app changes.
struct DynamicItems {
    new_terminal: MenuItem<Wry>,
}
/// Items that act on the main window's current tabs: ignored while it's hidden (a stray ⌘W
/// shouldn't reopen the window just to close a tab in it).
const TAB_ACTIONS: [&str; 3] = ["close-tab", "next-tab", "previous-tab"];

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?;
    let new_chat = MenuItemBuilder::with_id("new-chat", "New Chat").accelerator("CmdOrCtrl+N").build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let new_tab = MenuItemBuilder::with_id("new-tab", "New Tab").accelerator("CmdOrCtrl+T").build(app)?;
    let new_terminal = MenuItemBuilder::with_id(NEW_TERMINAL, "New Terminal")
        .accelerator("Ctrl+`")
        .enabled(false)
        .build(app)?;
    app.manage(DynamicItems { new_terminal: new_terminal.clone() });
    let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab").accelerator("CmdOrCtrl+W").build(app)?;
    let close_window = MenuItemBuilder::with_id(CLOSE_WINDOW, "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id("next-tab", "Show Next Tab").accelerator("Ctrl+Tab").build(app)?;
    let previous_tab = MenuItemBuilder::with_id("previous-tab", "Show Previous Tab")
        .accelerator("Ctrl+Shift+Tab")
        .build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT, "Quit Glade").accelerator("CmdOrCtrl+Q").build(app)?;
    let quit_completely = MenuItemBuilder::with_id(QUIT_COMPLETELY, "Quit Glade Completely")
        .accelerator("CmdOrCtrl+Alt+Q")
        .build(app)?;
    let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette…")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;

    let about = AboutMetadata {
        name: Some("Glade".into()),
        version: Some(app.package_info().version.to_string()),
        comments: Some("A desktop app for the pi coding agent".into()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, "Glade")
        .about(Some(about))
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .item(&quit_completely)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_chat)
        .item(&new_tab)
        .item(&new_terminal)
        .separator()
        .item(&close_tab)
        .item(&close_window)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&command_palette)
        .item(&toggle_sidebar)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&next_tab)
        .item(&previous_tab)
        .build()?;
    #[cfg(target_os = "macos")]
    let _ = window.set_as_windows_menu_for_nsapp();

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

/// The web app shows a chat (true) or not (false): File → New Terminal is enabled with one.
#[tauri::command]
pub fn menu_chat_open(app: AppHandle, open: bool) {
    if let Some(items) = app.try_state::<DynamicItems>() {
        let _ = items.new_terminal.set_enabled(open);
    }
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if crate::tray::handle(app, id) {
        return;
    }
    if id == QUIT {
        crate::quit::menu_quit(app);
    } else if id == QUIT_COMPLETELY {
        crate::quit::quit_completely(app);
    } else if APP_ACTIONS.contains(&id) {
        focus_main(app);
        let _ = app.emit_to(MAIN_WINDOW, MENU_EVENT, id);
    } else if TAB_ACTIONS.contains(&id) {
        let visible = app
            .get_webview_window(MAIN_WINDOW)
            .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
        if visible {
            let _ = app.emit_to(MAIN_WINDOW, MENU_EVENT, id);
        }
    } else if id == CLOSE_WINDOW {
        // Like the native item: close the key window (the main window hides, see lib.rs).
        let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
        if let Some(w) = focused {
            let _ = w.close();
        }
    }
}

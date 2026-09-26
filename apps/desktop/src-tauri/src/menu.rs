//! The macOS menu bar. Standard items (Edit, Window, Quit…) are predefined native items; the
//! app-specific ones are forwarded to the web app as a `pi-ui:menu` event whose payload is the
//! item id (`new-chat`, `settings`, `toggle-sidebar`).

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter};

use crate::{focus_main, MAIN_WINDOW};

pub const MENU_EVENT: &str = "pi-ui:menu";
const APP_ACTIONS: [&str; 3] = ["new-chat", "settings", "toggle-sidebar"];

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?;
    let new_chat = MenuItemBuilder::with_id("new-chat", "New Chat").accelerator("CmdOrCtrl+N").build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+\\")
        .build(app)?;

    let about = AboutMetadata {
        name: Some("pi-ui".into()),
        version: Some(app.package_info().version.to_string()),
        comments: Some("A desktop app for the pi coding agent".into()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, "pi-ui")
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
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File").item(&new_chat).separator().close_window().build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").item(&toggle_sidebar).separator().fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().close_window().build()?;
    #[cfg(target_os = "macos")]
    let _ = window.set_as_windows_menu_for_nsapp();

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if APP_ACTIONS.contains(&id) {
        focus_main(app);
        let _ = app.emit_to(MAIN_WINDOW, MENU_EVENT, id);
    }
}

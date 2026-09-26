//! pi-ui desktop shell (Tauri v2).
//!
//! - Release builds start the bundled Node server (`server.rs`) and point the window at it;
//!   `tauri dev` loads the Vite dev server instead (devUrl) and starts nothing.
//! - Native chrome: overlay titlebar (tauri.conf.json), sidebar vibrancy, app menu whose custom
//!   items are forwarded to the web app as `pi-ui:menu` events (see apps/web/src/lib/desktop.ts).
//! - Closing the window hides it (chats keep running, notifications still arrive); clicking the
//!   Dock icon brings it back; ⌘Q quits and stops the server.

mod menu;
mod server;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use server::{Bundle, ServerState};

pub const MAIN_WINDOW: &str = "main";

/// Show, unminimize and focus the main window.
pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn apply_vibrancy(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(e) = window_vibrancy::apply_vibrancy(
            window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        ) {
            eprintln!("[pi-ui] vibrancy unavailable: {e}");
        }
    }
}

/// Start the bundled server off the main thread, then navigate the window to it.
fn start_server(app: AppHandle) {
    std::thread::spawn(move || {
        let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
        let bundle = Bundle {
            server_js: resources.join("app").join("server.mjs"),
            web_dir: resources.join("app").join("web"),
        };
        let log_path = app
            .path()
            .app_log_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("server.log");
        match server::start(&bundle, &log_path) {
            Ok(running) => {
                let url = format!("http://127.0.0.1:{}/", running.port);
                *app.state::<ServerState>().0.lock().unwrap() = Some(running);
                if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                    if let Ok(url) = url.parse() {
                        let _ = w.navigate(url);
                    }
                }
            }
            Err(message) => show_startup_error(&app, &message),
        }
    });
}

fn show_startup_error(app: &AppHandle, message: &str) {
    eprintln!("[pi-ui] startup failed: {message}");
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        if let Ok(js) = serde_json::to_string(message) {
            let _ = w.eval(format!("window.__piShowError && window.__piShowError({js})"));
        }
    }
    app.dialog()
        .message(message)
        .title("pi-ui couldn't start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerState>() {
        if let Some(mut running) = state.0.lock().unwrap().take() {
            running.stop();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be first: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| focus_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ServerState::default())
        .menu(menu::build)
        .on_menu_event(menu::handle)
        .setup(|app| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                apply_vibrancy(&window);
            }
            if !tauri::is_dev() {
                start_server(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Keep running in the background when the window is closed (like Mail/Messages).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building pi-ui");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => focus_main(app),
        RunEvent::Exit => stop_server(app),
        _ => {}
    });
}

//! Glade desktop shell (Tauri v2).
//!
//! - Release builds start the bundled Node server (`server.rs`) and point the window at it;
//!   `tauri dev` loads the Vite dev server instead (devUrl) and starts nothing.
//! - Native chrome: overlay titlebar (tauri.conf.json), sidebar vibrancy, app menu whose custom
//!   items are forwarded to the web app as `glade:menu` events (see apps/web/src/lib/desktop.ts).
//! - Links never navigate the window away: external ones open in the default browser (`links.rs`,
//!   I-129).
//! - Closing the window hides it (chats keep running, the Dock badge keeps updating); clicking the
//!   Dock icon brings it back; ⌘Q quits and stops the server (after confirming if chats are
//!   working, see `quit.rs`).
//! - Device tokens for paired environments live in the Keychain (`secrets.rs`, I-134).
//! - System notifications with click-to-open (`notifications.rs`, I-135).
//! - The app always runs its own server, also while `pnpm dev` uses the same data folder: the
//!   servers share it safely (I-062), and each chat's agent runs in one of them at a time.

mod dev;
mod links;
mod menu;
mod notifications;
mod quit;
mod secrets;
mod server;
mod writing_tools;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WebviewWindowBuilder, WindowEvent};
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
            eprintln!("[glade] vibrancy unavailable: {e}");
        }
    }
}

/// Create the main window from its tauri.conf.json entry (`create: false` there) so it can get
/// the external-link guards (`links.rs`; `on_new_window` only exists on the builder).
fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
        .expect("main window missing from tauri.conf.json");
    WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(links::on_navigation)
        .on_new_window(|url, _features| links::on_new_window(url))
        .build()
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
        // A stable port keeps the web view's origin, and so its localStorage, across launches
        // (I-083). Builds with an overridden identifier (agents testing next to the installed
        // app) take any free port so they never grab the app's.
        let preferred_port = if server::env_var(dev::IDENTIFIER_ENV).is_some() {
            None
        } else if tauri::is_dev() {
            Some(server::PREFERRED_DEV_PORT)
        } else {
            Some(server::PREFERRED_PORT)
        };
        match server::start(&bundle, &log_path, preferred_port) {
            Ok(running) => {
                let url = running.url();
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
    eprintln!("[glade] startup failed: {message}");
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        if let Ok(js) = serde_json::to_string(message) {
            let _ = w.eval(format!("window.__gladeShowError && window.__gladeShowError({js})"));
        }
    }
    app.dialog()
        .message(message)
        .title("Glade couldn't start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

/// Stop our server (other servers on the same data folder keep running).
fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerState>() {
        if let Some(mut running) = state.0.lock().unwrap().take() {
            running.stop();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    dev::adjust_context(&mut context);
    let app = tauri::Builder::default()
        // Must be first: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| focus_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        // The web app opens links itself (lib/external-links.ts); skip the plugin's click script.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            notifications::notify_permission,
            notifications::notify_request,
            notifications::notify_show,
            notifications::notify_ready
        ])
        .menu(menu::build)
        .on_menu_event(menu::handle)
        .setup(|app| {
            let window = create_main_window(app.handle())?;
            apply_vibrancy(&window);
            writing_tools::disable_affordance(&window);
            quit::install(app.handle());
            notifications::install(app.handle());
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
        .build(context)
        .expect("error while building Glade");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => focus_main(app),
        RunEvent::Ready => dev::on_ready(),
        RunEvent::ExitRequested { api, .. } => {
            if !quit::should_quit_now(app) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_server(app),
        _ => {}
    });
}

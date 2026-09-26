//! pi-ui desktop shell (Tauri v2).
//!
//! - Release builds start the bundled Node server (`server.rs`) and point the window at it;
//!   `tauri dev` loads the Vite dev server instead (devUrl) and starts nothing.
//! - Native chrome: overlay titlebar (tauri.conf.json), sidebar vibrancy, app menu whose custom
//!   items are forwarded to the web app as `pi-ui:menu` events (see apps/web/src/lib/desktop.ts).
//! - Closing the window hides it (chats keep running, the Dock badge keeps updating); clicking the
//!   Dock icon brings it back; ⌘Q quits and stops the server (after confirming if chats are
//!   working, see `quit.rs`).
//! - If another server (e.g. `pnpm dev`) already owns the data folder, the window uses it
//!   instead, shows a one-time hint, and leaves it running on quit. If it goes away while the
//!   app is open, the app offers to start its own.

mod menu;
mod quit;
mod server;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use server::{Bundle, Connection, ExternalServer, ServerState};

pub const MAIN_WINDOW: &str = "main";

/// A hint to show once the page at `origin` has loaded: (origin, text).
#[derive(Default)]
struct PendingHint(Mutex<Option<(String, String)>>);

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
            Ok(conn) => {
                let url = conn.url();
                let external = match &conn {
                    Connection::External(e) => Some(e.clone()),
                    Connection::Owned(_) => None,
                };
                *app.state::<ServerState>().0.lock().unwrap() = Some(conn);
                if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                    let title = if external.is_some() { "pi-ui — using the running dev server" } else { "pi-ui" };
                    let _ = w.set_title(title);
                    if let Some(e) = &external {
                        let text = format!(
                            "Using the {} server that's already running (port {}). Quitting pi-ui won't stop it.",
                            if e.kind == "desktop" { "pi-ui" } else { "dev" },
                            e.port
                        );
                        *app.state::<PendingHint>().0.lock().unwrap() = Some((url.clone(), text));
                    }
                    if let Ok(url) = url.parse() {
                        let _ = w.navigate(url);
                    }
                }
                if let Some(e) = external {
                    watch_external(app, e);
                }
            }
            Err(message) => show_startup_error(&app, &message),
        }
    });
}

/// While we use someone else's server: if it goes away (for longer than a `tsx watch` restart),
/// offer to start our own. Runs on the caller's thread until we stop using that server.
fn watch_external(app: AppHandle, e: ExternalServer) {
    let mut down = 0;
    let mut asked = false;
    loop {
        std::thread::sleep(Duration::from_secs(3));
        let still_using = matches!(
            &*app.state::<ServerState>().0.lock().unwrap(),
            Some(Connection::External(cur)) if cur.port == e.port && cur.host == e.host
        );
        if !still_using || quit::allowed() {
            return;
        }
        if server::is_up(&e.host, e.port) {
            down = 0;
            asked = false;
            continue;
        }
        down += 1;
        if down < 3 || asked {
            continue;
        }
        asked = true;
        let start = app
            .dialog()
            .message("The pi-ui server this window was using has stopped. Start pi-ui's own server?")
            .title("Server stopped")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Start Server".into(), "Not Now".into()))
            .blocking_show();
        if start && !server::is_up(&e.host, e.port) {
            app.state::<ServerState>().0.lock().unwrap().take();
            start_server(app);
            return;
        }
    }
}

/// Show the pending hint as a small, self-dismissing notice over the page.
fn show_hint(webview: &tauri::Webview, url: &tauri::Url) {
    let Some(state) = webview.try_state::<PendingHint>() else { return };
    let mut pending = state.0.lock().unwrap();
    let matches = matches!(&*pending, Some((origin, _)) if url.as_str().starts_with(origin.as_str()));
    if !matches {
        return;
    }
    let Some((_, text)) = pending.take() else { return };
    let Ok(text) = serde_json::to_string(&text) else { return };
    let _ = webview.eval(format!(
        r#"(() => {{
  const el = document.createElement("div");
  el.textContent = {text};
  el.setAttribute("role", "status");
  el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;" +
    "max-width:80vw;padding:6px 12px;border-radius:8px;font:12px -apple-system,system-ui,sans-serif;" +
    "background:Canvas;color:CanvasText;border:0.5px solid color-mix(in srgb, CanvasText 20%, transparent);" +
    "box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:none;user-select:none;opacity:0;transition:opacity .3s";
  document.body.appendChild(el);
  requestAnimationFrame(() => {{ el.style.opacity = "0.97"; }});
  setTimeout(() => {{ el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }}, 6000);
}})()"#
    ));
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

/// Stop the server if we started it; someone else's keeps running.
fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerState>() {
        if let Some(Connection::Owned(mut running)) = state.0.lock().unwrap().take() {
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
        .manage(ServerState::default())
        .manage(PendingHint::default())
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                show_hint(webview, payload.url());
            }
        })
        .menu(menu::build)
        .on_menu_event(menu::handle)
        .setup(|app| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                apply_vibrancy(&window);
            }
            quit::install(app.handle());
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
        RunEvent::ExitRequested { api, .. } => {
            if !quit::should_quit_now(app) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_server(app),
        _ => {}
    });
}

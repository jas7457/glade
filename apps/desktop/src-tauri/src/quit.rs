//! Confirm quitting while chats are working.
//!
//! Quitting the app stops the server it started, and with it every running agent. So before
//! quitting we ask that server (`GET /api/chats`) how many chats are `working`/`blocked` and, if
//! any, show "N chats are still working. Quitting stops them." [Quit] [Cancel]. No prompt when we
//! don't own the server (its agents keep running) or when it can't be asked.
//!
//! ⌘Q, the Dock's Quit and AppleScript `quit` all go through `-[NSApplication terminate:]`, which
//! tao doesn't let us veto (it has no `applicationShouldTerminate:`), so `install` adds that
//! delegate method. `RunEvent::ExitRequested` is handled too, for exits Tauri itself initiates.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::server::{self, ServerState};
use crate::{focus_main, MAIN_WINDOW};

/// Set once the user confirmed (or nothing needed confirming): the next quit goes through.
static QUIT_ALLOWED: AtomicBool = AtomicBool::new(false);
/// A confirm dialog is up; further quit requests are ignored until it's answered.
static CONFIRMING: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Hook quitting. Call once from `setup`.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "macos")]
    macos::add_should_terminate();
}

pub fn allowed() -> bool {
    QUIT_ALLOWED.load(Ordering::SeqCst)
}

/// Busy chats on our server; 0 if it isn't running or can't be asked.
fn busy_chats(app: &AppHandle) -> usize {
    let target = app
        .try_state::<ServerState>()
        .and_then(|state| state.0.lock().unwrap().as_ref().map(|s| (s.host().to_string(), s.port)));
    target.and_then(|(host, port)| server::busy_chats(&host, port)).unwrap_or(0)
}

/// Decide a quit request now (on the main thread). Returns true if the app may quit right away;
/// otherwise a confirm dialog is (or already was) shown and the app quits if the user agrees.
pub fn should_quit_now(app: &AppHandle) -> bool {
    if allowed() {
        return true;
    }
    if CONFIRMING.load(Ordering::SeqCst) {
        return false;
    }
    let busy = busy_chats(app);
    if busy == 0 {
        QUIT_ALLOWED.store(true, Ordering::SeqCst);
        return true;
    }
    confirm_async(app.clone(), busy);
    false
}

fn confirm_async(app: AppHandle, busy: usize) {
    if CONFIRMING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        focus_main(&app);
        let message = if busy == 1 {
            "1 chat is still working. Quitting stops it.".to_string()
        } else {
            format!("{busy} chats are still working. Quitting stops them.")
        };
        let mut dialog = app
            .dialog()
            .message(message)
            .title("Quit Glade?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()));
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            dialog = dialog.parent(&window);
        }
        let quit = dialog.blocking_show();
        CONFIRMING.store(false, Ordering::SeqCst);
        if quit {
            QUIT_ALLOWED.store(true, Ordering::SeqCst);
            app.exit(0);
        }
    });
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::ffi;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};

    const NS_TERMINATE_CANCEL: usize = 0;
    const NS_TERMINATE_NOW: usize = 1;

    extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
        let quit = super::APP.get().is_none_or(super::should_quit_now);
        if quit {
            NS_TERMINATE_NOW
        } else {
            NS_TERMINATE_CANCEL
        }
    }

    /// Add `applicationShouldTerminate:` to the app delegate's class (tao's delegate lacks it).
    pub fn add_should_terminate() {
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() {
                eprintln!("[glade] no app delegate; quit confirmation disabled");
                return;
            }
            let cls = ffi::object_getClass(delegate) as *mut AnyClass;
            let imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
                Imp,
            >(should_terminate);
            // NSApplicationTerminateReply (NSUInteger) applicationShouldTerminate:(NSApplication *)
            let added = ffi::class_addMethod(cls, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
            if !added.as_bool() {
                eprintln!("[glade] applicationShouldTerminate: already defined; quit confirmation disabled");
            }
        }
    }
}

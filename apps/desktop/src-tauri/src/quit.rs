//! Quitting (I-150) and confirming it while chats are working.
//!
//! Three ways out, decided by `decide` (pure):
//! - **⌘Q** (the app menu's "Quit Glade") with "⌘Q keeps Glade in the menu bar" on (default):
//!   close the windows and drop the Dock icon (`dock.rs`); the server, agents, sharing and
//!   notifications keep running. The first time, a one-line notice says so.
//! - **Quit Glade Completely** (⌥⌘Q, the menu bar menu), ⌘Q with that setting off, and every
//!   `-[NSApplication terminate:]` (the Dock's Quit, AppleScript `quit`, e.g. an installer): quit
//!   for real, after the running-chats check below.
//! - **Logout, restart, shutdown**: quit at once, never hidden and never held up by a dialog. We
//!   know it's one from `NSWorkspaceWillPowerOffNotification` or the quit Apple Event's
//!   `kAEQuitReason`.
//!
//! Quitting stops the server the app started, and with it every running agent. So before
//! quitting we ask that server (`GET /api/sessions`) how many chats are `working`/`blocked` and, if
//! any, show "N chats are still working. Quitting stops them." [Quit] [Cancel]. No prompt when we
//! don't own the server (its agents keep running) or when it can't be asked.
//!
//! `terminate:` can't be vetoed through tao (it has no `applicationShouldTerminate:`), so
//! `install` adds that delegate method. `RunEvent::ExitRequested` is handled too, for exits Tauri
//! itself initiates.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::server::{self, ServerState};
use crate::{focus_main, MAIN_WINDOW};

/// Set once the user confirmed (or nothing needed confirming): the next quit goes through.
static QUIT_ALLOWED: AtomicBool = AtomicBool::new(false);
/// The system is logging out, restarting or shutting down.
static POWERING_OFF: AtomicBool = AtomicBool::new(false);
/// A confirm dialog is up; further quit requests are ignored until it's answered.
static CONFIRMING: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Hook quitting. Call once from `setup`.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "macos")]
    {
        macos::add_should_terminate();
        macos::observe_power_off();
    }
}

/// Where a quit request came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitRequest {
    /// The app menu's "Quit Glade" (⌘Q).
    MenuQuit,
    /// "Quit Glade Completely" (⌥⌘Q, the menu bar menu).
    Completely,
    /// `-[NSApplication terminate:]`: the Dock's Quit, AppleScript `quit` (installers).
    Terminate,
    /// Logout, restart or shutdown.
    PowerOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitAction {
    /// Close the windows, keep running in the menu bar.
    CloseToMenuBar,
    /// Quit, after the running-chats check.
    Quit,
    /// Quit now, no questions (the system is going down).
    QuitNow,
}

/// The quit-path decision (pure). Only our own ⌘Q item ever turns into "close to the menu bar".
pub fn decide(request: QuitRequest, quit_to_menu_bar: bool) -> QuitAction {
    match request {
        QuitRequest::MenuQuit if quit_to_menu_bar => QuitAction::CloseToMenuBar,
        QuitRequest::PowerOff => QuitAction::QuitNow,
        _ => QuitAction::Quit,
    }
}

/// The app menu's ⌘Q.
pub fn menu_quit(app: &AppHandle) {
    match decide(QuitRequest::MenuQuit, crate::prefs::get(app).quit_to_menu_bar) {
        QuitAction::CloseToMenuBar => close_to_menu_bar(app),
        _ => quit_completely(app),
    }
}

/// "Quit Glade Completely": quit after the running-chats check.
pub fn quit_completely(app: &AppHandle) {
    debug_assert_eq!(decide(QuitRequest::Completely, true), QuitAction::Quit);
    if should_quit_now(app) {
        app.exit(0);
    }
}

pub const MENU_BAR_NOTICE: &str = "Glade is still running in the menu bar. Quit it there to stop everything.";

/// Close every window and drop the Dock icon; everything keeps running. The first time, say so.
pub fn close_to_menu_bar(app: &AppHandle) {
    let prefs = crate::prefs::get(app);
    if prefs.quit_notice_shown {
        hide_to_menu_bar(app);
        return;
    }
    crate::prefs::update(app, &serde_json::json!({ "quitNoticeShown": true }));
    let handle = app.clone();
    let mut dialog = app
        .dialog()
        .message(MENU_BAR_NOTICE)
        .title("Glade keeps running")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW).filter(|w| w.is_visible().unwrap_or(false)) {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |_| hide_to_menu_bar(&handle));
}

fn hide_to_menu_bar(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    crate::dock::set_in_menu_bar(true, app);
}

/// The system is logging out / restarting / shutting down (then quits skip every question).
pub fn powering_off() -> bool {
    if POWERING_OFF.load(Ordering::SeqCst) {
        return true;
    }
    #[cfg(target_os = "macos")]
    if macos::quit_event_from_system() {
        return true;
    }
    false
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
    if decide(if powering_off() { QuitRequest::PowerOff } else { QuitRequest::Terminate }, false) == QuitAction::QuitNow {
        QUIT_ALLOWED.store(true, Ordering::SeqCst);
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

    /// `kAEQuitReason` ('why?') of the Apple Event being handled: set when the system quits apps
    /// for a logout, restart or shutdown.
    const KEY_QUIT_REASON: u32 = u32::from_be_bytes(*b"why?");

    /// The quit being handled is the system's (logout / restart / shutdown).
    pub fn quit_event_from_system() -> bool {
        unsafe {
            let manager: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
            if manager.is_null() {
                return false;
            }
            let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
            if event.is_null() {
                return false;
            }
            let reason: *mut AnyObject = msg_send![event, attributeDescriptorForKeyword: KEY_QUIT_REASON];
            if reason.is_null() {
                return false;
            }
            let code: u32 = msg_send![reason, enumCodeValue];
            // kAELogOut, kAEReallyLogOut, kAEShowRestartDialog, kAEShowShutdownDialog, kAERestart, kAEShutDown
            [*b"logo", *b"rlgo", *b"rrst", *b"rsdn", *b"rest", *b"shut"].iter().any(|c| u32::from_be_bytes(*c) == code)
        }
    }

    /// Remember `NSWorkspaceWillPowerOffNotification` (logout, restart, shutdown).
    pub fn observe_power_off() {
        use block2::RcBlock;
        use objc2_foundation::NSString;
        unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return;
            }
            let center: *mut AnyObject = msg_send![workspace, notificationCenter];
            let name = NSString::from_str("NSWorkspaceWillPowerOffNotification");
            let block = RcBlock::new(|_note: *mut AnyObject| {
                super::POWERING_OFF.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            let nil: *mut AnyObject = std::ptr::null_mut();
            let observer: *mut AnyObject =
                msg_send![center, addObserverForName: &*name, object: nil, queue: nil, usingBlock: &*block];
            // Kept for the app's lifetime (the center retains the observer; never removed).
            let _ = observer;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_paths() {
        // ⌘Q closes to the menu bar only with the setting on.
        assert_eq!(decide(QuitRequest::MenuQuit, true), QuitAction::CloseToMenuBar);
        assert_eq!(decide(QuitRequest::MenuQuit, false), QuitAction::Quit);
        // Quit Glade Completely, the Dock's Quit, AppleScript/installers: always a real quit.
        for q in [QuitRequest::Completely, QuitRequest::Terminate] {
            assert_eq!(decide(q, true), QuitAction::Quit);
            assert_eq!(decide(q, false), QuitAction::Quit);
        }
        // Logout / restart / shutdown: quit now, no dialog, never hidden.
        assert_eq!(decide(QuitRequest::PowerOff, true), QuitAction::QuitNow);
        assert_eq!(decide(QuitRequest::PowerOff, false), QuitAction::QuitNow);
    }
}

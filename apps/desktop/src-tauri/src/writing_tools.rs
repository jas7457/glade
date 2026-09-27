//! Hide Apple Intelligence Writing Tools' floating button ("Write with Siri") on text fields.
//!
//! AppKit shows that affordance next to a focused multi-line field when the web view answers YES
//! to `-allowsWritingToolsAffordance` (WebKit's `WebViewImpl::shouldAllowWritingToolsAffordance`:
//! editable selection and not a single-line input). Tested on macOS 27 with a bare WKWebView:
//! neither `WKWebViewConfiguration.writingToolsBehavior = .none` (even set before creation) nor
//! the HTML `writingsuggestions="false"` / `autocorrect="off"` attributes hide it. So we answer
//! NO ourselves by adding the method to the web view's class (wry's `WryWebView` subclass, so
//! only our views change). Typing, spellcheck, selection and copy/paste are unaffected; Writing
//! Tools should stay reachable from the context menu.

use tauri::WebviewWindow;

/// Turn the affordance off for `window`'s web view. Call once from `setup`.
pub fn disable_affordance(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let result = window.with_webview(|webview| {
            macos::override_affordance(webview.inner().cast());
        });
        if let Err(e) = result {
            eprintln!("[glade] couldn't reach the web view to hide Writing Tools: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::ffi;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::sel;

    extern "C-unwind" fn allows_writing_tools_affordance(_this: *mut AnyObject, _cmd: Sel) -> Bool {
        Bool::NO
    }

    pub fn override_affordance(webview: *mut AnyObject) {
        if webview.is_null() {
            return;
        }
        unsafe {
            let cls = ffi::object_getClass(webview) as *mut AnyClass;
            let imp: Imp =
                std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool, Imp>(allows_writing_tools_affordance);
            // BOOL allowsWritingToolsAffordance (macOS 15.2+; harmless where AppKit never asks).
            // `class_replaceMethod` adds it to the subclass (overriding WKWebView's) or replaces ours.
            ffi::class_replaceMethod(cls, sel!(allowsWritingToolsAffordance), imp, c"B@:".as_ptr());
        }
    }
}

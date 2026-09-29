//! Hides the WebView's form accessory bar (I-164): the ↑ ↓ ✓ strip iOS puts above the keyboard
//! for web text fields. It's meant for forms; in a chat it looks like a find bar and its frame
//! leaves a gap between the composer and the keyboard.
//!
//! WKWebView has no API for it: the bar is the `inputAccessoryView` of its private content view
//! (`WKContentView`). Like Capacitor's Keyboard plugin, we give that one view a runtime subclass
//! whose `inputAccessoryView` is nil. If Apple renames the class, nothing happens (the bar stays).

use std::ffi::CString;

use objc2::ffi::object_setClass;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
use objc2::sel;

extern "C" fn no_accessory_view(_this: *mut AnyObject, _cmd: Sel) -> *mut AnyObject {
    std::ptr::null_mut()
}

/// `webview` is the WKWebView (Tauri's `PlatformWebview::inner()` on iOS).
///
/// # Safety
/// Must be called on the main thread with a live WKWebView.
pub unsafe fn hide(webview: *mut AnyObject) {
    if webview.is_null() {
        return;
    }
    let scroll: *mut AnyObject = msg_send![webview, scrollView];
    if scroll.is_null() {
        return;
    }
    let subviews: *mut AnyObject = msg_send![scroll, subviews];
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let view: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
        let class: &AnyClass = (*view).class();
        let name = class.name().to_string_lossy().into_owned();
        if !name.starts_with("WKContent") {
            continue;
        }
        let Ok(sub_name) = CString::new(format!("{name}_GladeNoAccessoryBar")) else { continue };
        let sub = AnyClass::get(&sub_name).or_else(|| {
            let mut builder = ClassBuilder::new(&sub_name, class)?;
            builder.add_method(sel!(inputAccessoryView), no_accessory_view as extern "C" fn(_, _) -> _);
            Some(builder.register())
        });
        if let Some(sub) = sub {
            object_setClass(view, sub);
        }
    }
}

//! "Open at login" (I-150): the app itself as a login item through `SMAppService.mainAppService`
//! (macOS 13+; ServiceManagement). The toggle in Settings → General reads the system's status, so
//! it also reflects changes made in System Settings › General › Login Items.
//!
//! Status strings: "enabled", "disabled", "requires-approval" (the user must allow it in System
//! Settings), "unavailable" (macOS 12, or not an app bundle).

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    // SMAppServiceStatus
    const NOT_REGISTERED: isize = 0;
    const ENABLED: isize = 1;
    const REQUIRES_APPROVAL: isize = 2;

    fn service() -> Option<*mut AnyObject> {
        let exe = std::env::current_exe().ok()?;
        if !exe.to_string_lossy().contains(".app/Contents/MacOS/") {
            return None;
        }
        let cls = AnyClass::get(c"SMAppService")?;
        let service: *mut AnyObject = unsafe { msg_send![cls, mainAppService] };
        (!service.is_null()).then_some(service)
    }

    fn status_name(status: isize) -> &'static str {
        match status {
            ENABLED => "enabled",
            REQUIRES_APPROVAL => "requires-approval",
            NOT_REGISTERED => "disabled",
            _ => "disabled", // not found
        }
    }

    pub fn status() -> &'static str {
        let Some(service) = service() else { return "unavailable" };
        let status: isize = unsafe { msg_send![service, status] };
        status_name(status)
    }

    pub fn set(enabled: bool) -> Result<String, String> {
        let service = service().ok_or("Open at login isn't available in this build of Glade.")?;
        let mut error: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = unsafe {
            if enabled {
                msg_send![service, registerAndReturnError: &mut error]
            } else {
                msg_send![service, unregisterAndReturnError: &mut error]
            }
        };
        if !ok && !error.is_null() {
            let description: *mut AnyObject = unsafe { msg_send![error, localizedDescription] };
            let text = if description.is_null() {
                "unknown error".to_string()
            } else {
                let utf8: *const std::ffi::c_char = unsafe { msg_send![description, UTF8String] };
                if utf8.is_null() { "unknown error".into() } else { unsafe { std::ffi::CStr::from_ptr(utf8) }.to_string_lossy().into_owned() }
            };
            // Unregistering something that isn't registered is fine.
            if enabled || status() != "disabled" {
                return Err(format!("Couldn't change Open at login: {text}"));
            }
        }
        Ok(status().to_string())
    }
}

#[cfg(target_os = "macos")]
pub use macos::{set, status};

#[cfg(not(target_os = "macos"))]
pub fn status() -> &'static str {
    "unavailable"
}
#[cfg(not(target_os = "macos"))]
pub fn set(_enabled: bool) -> Result<String, String> {
    Err("Open at login is only available on macOS".into())
}

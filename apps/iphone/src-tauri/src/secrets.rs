//! Secrets in the iOS Keychain (I-164): the device tokens of the Macs this iPhone is paired with,
//! and the iPhone's own device id. A copy of apps/desktop/src-tauri/src/secrets.rs (same commands,
//! same key rules), built for iOS too.
//!
//! - Commands `secret_get` / `secret_set` / `secret_delete`, used by apps/iphone/src/lib/secrets.ts
//!   and allowed for the main window only (capabilities/default.json; permissions from build.rs).
//! - Generic-password items: service = the app identifier (so dev builds and agents' test builds
//!   with `GLADE_APP_IDENTIFIER` never touch the installed app's items), account = the key.
//!   On iOS the items are also confined to this app's own keychain access group.
//! - Only `env:<environmentId>` keys and `device:id` (the iPhone's own stable id, sent as
//!   `clientEnvironmentId` when pairing) are accepted, so the web view can't read or overwrite
//!   anything else stored under our service.

use tauri::{AppHandle, Runtime};

/// Longest accepted key and value (a device token is ~43 characters).
const MAX_KEY_LEN: usize = 200;
const MAX_VALUE_LEN: usize = 8 * 1024;
const KEY_PREFIX: &str = "env:";
/// The iPhone's own device id.
const DEVICE_ID_KEY: &str = "device:id";

/// Accept `device:id`, or `env:<id>` where the id is 1+ of `A-Z a-z 0-9 . _ -`.
fn validate_key(key: &str) -> Result<(), String> {
    if key == DEVICE_ID_KEY {
        return Ok(());
    }
    let id = key
        .strip_prefix(KEY_PREFIX)
        .ok_or_else(|| format!("secret keys must start with \"{KEY_PREFIX}\""))?;
    if id.is_empty() || key.len() > MAX_KEY_LEN {
        return Err("invalid secret key length".into());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err("invalid characters in secret key".into());
    }
    Ok(())
}

fn validate_value(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_VALUE_LEN {
        return Err("invalid secret length".into());
    }
    Ok(())
}

fn service<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config().identifier.clone()
}

#[tauri::command]
pub fn secret_get<R: Runtime>(app: AppHandle<R>, key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    keychain::get(&service(&app), &key)
}

#[tauri::command]
pub fn secret_set<R: Runtime>(app: AppHandle<R>, key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    validate_value(&value)?;
    keychain::set(&service(&app), &key, &value)
}

#[tauri::command]
pub fn secret_delete<R: Runtime>(app: AppHandle<R>, key: String) -> Result<(), String> {
    validate_key(&key)?;
    keychain::delete(&service(&app), &key)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod keychain {
    use security_framework::base::Error;
    use security_framework::passwords;

    /// `errSecItemNotFound`.
    const NOT_FOUND: i32 = -25300;

    fn describe(e: Error) -> String {
        format!("Keychain error {}: {}", e.code(), e.message().unwrap_or_default())
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
        match passwords::get_generic_password(service, account) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| "Keychain item isn't text".into()),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(describe(e)),
        }
    }

    pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
        passwords::set_generic_password(service, account, value.as_bytes()).map_err(describe)
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        match passwords::delete_generic_password(service, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(e) => Err(describe(e)),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod keychain {
    const UNSUPPORTED: &str = "secure storage is only implemented on Apple platforms";
    pub fn get(_: &str, _: &str) -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn set(_: &str, _: &str, _: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    pub fn delete(_: &str, _: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_environment_keys() {
        assert!(validate_key("env:ENV-B").is_ok());
        assert!(validate_key("env:3f2a9c1e-7b4d-4e8a-9f1c-0a1b2c3d4e5f").is_ok());
        assert!(validate_key("env:a.b_c").is_ok());
        assert!(validate_key("device:id").is_ok());
    }

    #[test]
    fn rejects_other_keys() {
        for key in ["", "env:", "ENV:x", "token", "envx", "x:env:a", "env:a b", "env:a/b", "env:ä", "env:a:b", "device:", "device:idx", "device:other"] {
            assert!(validate_key(key).is_err(), "{key:?} should be rejected");
        }
        assert!(validate_key(&format!("env:{}", "a".repeat(MAX_KEY_LEN))).is_err());
    }

    #[test]
    fn validates_values() {
        assert!(validate_value("token").is_ok());
        assert!(validate_value("").is_err());
        assert!(validate_value(&"a".repeat(MAX_VALUE_LEN + 1)).is_err());
    }
}

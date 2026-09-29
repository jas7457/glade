//! Preferences of the Mac app itself (I-150), stored by the shell (not the server): they're needed
//! before the server runs (the Dock icon at launch) and belong to this app install.
//!
//! `<app config dir>/desktop-prefs.json` (keyed on the bundle identifier, so test builds with
//! `GLADE_APP_IDENTIFIER` get their own):
//! - `showInDock` (default on): off = Glade lives only in the menu bar, also with its window open.
//! - `quitToMenuBar` (default on): ⌘Q closes the windows and keeps Glade running in the menu bar.
//! - `quitNoticeShown`: the one-time "still running in the menu bar" notice was shown.
//!
//! Commands (main window only): `desktop_prefs_get`, `desktop_prefs_set` (a partial patch),
//! `login_item_get` / `login_item_set` ("Open at login", the system's login item, `login_item.rs`).
//! The web side is apps/web/src/lib/desktop.ts.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopPrefs {
    pub show_in_dock: bool,
    pub quit_to_menu_bar: bool,
    pub quit_notice_shown: bool,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self { show_in_dock: true, quit_to_menu_bar: true, quit_notice_shown: false }
    }
}

impl DesktopPrefs {
    pub fn from_json(value: &Value) -> Self {
        let mut prefs = Self::default();
        prefs.apply(value);
        prefs
    }

    /// Apply a partial patch; unknown keys and wrong types are ignored.
    pub fn apply(&mut self, patch: &Value) {
        let flag = |key: &str| patch.get(key).and_then(Value::as_bool);
        if let Some(v) = flag("showInDock") {
            self.show_in_dock = v;
        }
        if let Some(v) = flag("quitToMenuBar") {
            self.quit_to_menu_bar = v;
        }
        if let Some(v) = flag("quitNoticeShown") {
            self.quit_notice_shown = v;
        }
    }

    pub fn to_json(self) -> Value {
        json!({ "showInDock": self.show_in_dock, "quitToMenuBar": self.quit_to_menu_bar, "quitNoticeShown": self.quit_notice_shown })
    }
}

/// Managed state: the prefs and where they're saved.
pub struct PrefsState {
    prefs: Mutex<DesktopPrefs>,
    path: Option<PathBuf>,
}

impl PrefsState {
    pub fn load(app: &AppHandle) -> Self {
        let path = app.path().app_config_dir().ok().map(|d| d.join("desktop-prefs.json"));
        let prefs = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|v| DesktopPrefs::from_json(&v))
            .unwrap_or_default();
        Self { prefs: Mutex::new(prefs), path }
    }

    pub fn get(&self) -> DesktopPrefs {
        *self.prefs.lock().unwrap()
    }

    pub fn update(&self, patch: &Value) -> DesktopPrefs {
        let mut prefs = self.prefs.lock().unwrap();
        prefs.apply(patch);
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Err(e) = std::fs::write(path, prefs.to_json().to_string()) {
                eprintln!("[glade] couldn't save {}: {e}", path.display());
            }
        }
        *prefs
    }
}

/// The prefs (defaults if the state isn't managed yet).
pub fn get(app: &AppHandle) -> DesktopPrefs {
    app.try_state::<PrefsState>().map(|s| s.get()).unwrap_or_default()
}

pub fn update(app: &AppHandle, patch: &Value) -> DesktopPrefs {
    match app.try_state::<PrefsState>() {
        Some(state) => state.update(patch),
        None => DesktopPrefs::default(),
    }
}

#[tauri::command]
pub fn desktop_prefs_get(app: AppHandle) -> Value {
    get(&app).to_json()
}

#[tauri::command]
pub fn desktop_prefs_set(app: AppHandle, patch: Value) -> Value {
    let before = get(&app);
    let after = update(&app, &patch);
    if before.show_in_dock != after.show_in_dock {
        crate::dock::apply(&app);
    }
    after.to_json()
}

#[tauri::command]
pub async fn login_item_get() -> String {
    tauri::async_runtime::spawn_blocking(crate::login_item::status).await.unwrap_or("unavailable").to_string()
}

#[tauri::command]
pub async fn login_item_set(enabled: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::login_item::set(enabled)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_patches() {
        let d = DesktopPrefs::default();
        assert!(d.show_in_dock && d.quit_to_menu_bar && !d.quit_notice_shown);
        let mut p = DesktopPrefs::from_json(&json!({ "showInDock": false, "junk": 1, "quitToMenuBar": "yes" }));
        assert!(!p.show_in_dock);
        assert!(p.quit_to_menu_bar, "wrong types are ignored");
        p.apply(&json!({ "quitNoticeShown": true }));
        assert_eq!(DesktopPrefs::from_json(&p.to_json()), p);
    }
}

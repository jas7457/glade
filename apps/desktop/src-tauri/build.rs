fn main() {
    // App commands listed here need a permission (`allow-<command>`) in a capability, so the
    // Keychain commands (src/secrets.rs, I-134) and the notification commands
    // (src/notifications.rs, I-135) are only callable from the main window. `relaunch` (src/relaunch.rs,
    // I-154) restarts into a newly installed version.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "secret_get",
            "secret_set",
            "secret_delete",
            "notify_permission",
            "notify_request",
            "notify_show",
            "notify_ready",
            "desktop_prefs_get",
            "desktop_prefs_set",
            "login_item_get",
            "login_item_set",
            "relaunch",
        ])),
    )
    .expect("failed to run tauri-build");
}

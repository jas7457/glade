fn main() {
    // App commands listed here need a permission (`allow-<command>`) in a capability, so the
    // Keychain commands (src/secrets.rs, I-134) are only callable from the main window.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "secret_get",
            "secret_set",
            "secret_delete",
        ])),
    )
    .expect("failed to run tauri-build");
}

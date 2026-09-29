//! Update Now's restart (I-154): quit Glade completely and start the newly installed bundle.
//!
//! The web asks for it (`relaunch` command, apps/web/src/lib/desktop.ts) after the update job
//! installed the new version and the page already dealt with running chats, so:
//! - no running-chats prompt and no ⌘Q-to-menu-bar: `quit::allow()`, then `app.exit(0)`, which
//!   stops our server cleanly (SIGTERM, like Quit Glade Completely; `RunEvent::Exit` in lib.rs);
//! - the route to reopen is saved in `<app config dir>/relaunch-route` and taken once by the next
//!   launch (`take_route`), which opens the window there instead of `/`;
//! - a small detached helper (`/bin/sh`) waits for this process to exit, then `open -n`s the
//!   bundle **by path**. `pnpm tauri:install` swapped the new bundle into the same path (I-082),
//!   so this starts the new version, never the old copy that was deleted. The path is resolved at
//!   startup (`remember_bundle`), while the old bundle still existed. The variables a test build
//!   was started with (`FORWARDED`: its own identifier, data folder, harness, install target) are
//!   passed on with `open --env`; nothing else (e.g. an agent's identity) is.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

static BUNDLE: OnceLock<Option<PathBuf>> = OnceLock::new();

const ROUTE_FILE: &str = "relaunch-route";

/// Resolve and keep the `.app` we run from. Call once from `setup`.
pub fn remember_bundle() {
    let _ = BUNDLE.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
        bundle_of(&exe)
    });
}

/// `/Applications/Glade.app` for `/Applications/Glade.app/Contents/MacOS/glade`; None when the
/// binary isn't inside an app bundle (e.g. `cargo run` without the dev runner).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_app = bundle.extension().is_some_and(|e| e == "app");
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && is_app).then(|| bundle.to_path_buf())
}

/// A route of this web app (`/settings/about?x=1`): absolute, same origin, no control characters.
pub fn valid_route(route: &str) -> bool {
    route.starts_with('/') && !route.starts_with("//") && route.len() <= 2048 && !route.chars().any(|c| c.is_control() || c == '\\')
}

/// The helper's script: `$1` is our pid, the rest are `open`'s arguments. Waits up to ~60 s.
pub const HELPER: &str = r#"pid="$1"; shift; i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i+1)); done; exec /usr/bin/open -n "$@""#;

/// Our variables the restarted app keeps (short names, under `GLADE_` or the pre-rename `PI_UI_`).
const FORWARDED: [&str; 4] = ["APP_IDENTIFIER", "DATA_DIR", "HARNESS", "INSTALL_TARGET"];

/// `open`'s arguments: `--env` for each forwarded variable we have, then the bundle.
pub fn open_args(bundle: &Path, env: impl Iterator<Item = (String, String)>) -> Vec<String> {
    let mut args = Vec::new();
    for (key, value) in env {
        let short = key.strip_prefix(crate::server::ENV_PREFIX).or_else(|| key.strip_prefix("PI_UI_"));
        if short.is_some_and(|s| FORWARDED.contains(&s)) {
            args.push("--env".to_string());
            args.push(format!("{key}={value}"));
        }
    }
    args.push(bundle.to_string_lossy().into_owned());
    args
}

fn route_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(ROUTE_FILE))
}

/// The route saved by the last relaunch, once (the file is removed).
pub fn take_route(app: &AppHandle) -> Option<String> {
    let path = route_file(app)?;
    let route = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let route = route.trim().to_string();
    valid_route(&route).then_some(route)
}

#[tauri::command]
pub fn relaunch(app: AppHandle, route: String) -> Result<(), String> {
    let bundle = BUNDLE
        .get()
        .cloned()
        .flatten()
        .ok_or("Glade isn't running from an app bundle, so it can't restart itself. Quit it and open it again.")?;
    if !bundle.join("Contents").join("Info.plist").exists() {
        return Err(format!("{} is missing. Open Glade again from where it's installed.", bundle.display()));
    }
    if valid_route(&route) {
        if let Some(path) = route_file(&app) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, &route);
        }
    }
    let mut helper = Command::new("/bin/sh");
    helper
        .arg("-c")
        .arg(HELPER)
        .arg("glade-relaunch")
        .arg(std::process::id().to_string())
        .args(open_args(&bundle, std::env::vars()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group: it outlives us and a terminal's Ctrl-C doesn't reach it.
        helper.process_group(0);
    }
    helper.spawn().map_err(|e| format!("Couldn't restart Glade: {e}"))?;
    crate::quit::allow();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle() {
        assert_eq!(bundle_of(Path::new("/Applications/Glade.app/Contents/MacOS/glade")), Some(PathBuf::from("/Applications/Glade.app")));
        assert_eq!(bundle_of(Path::new("/tmp/x/target/release/glade")), None);
        assert_eq!(bundle_of(Path::new("/tmp/Glade/Contents/MacOS/glade")), None);
    }

    #[test]
    fn routes() {
        assert!(valid_route("/"));
        assert!(valid_route("/settings/about"));
        assert!(valid_route("/projects/p1/chats/c1?tab=x"));
        assert!(!valid_route("//evil.example/x"));
        assert!(!valid_route("https://evil.example/"));
        assert!(!valid_route("/a\nb"));
        assert!(!valid_route(""));
    }

    #[test]
    fn passes_our_variables_to_open() {
        let env = [("GLADE_APP_IDENTIFIER", "dev.x"), ("HOME", "/Users/me"), ("GLADE_TOKEN", "secret"), ("PI_UI_DATA_DIR", "/tmp/d")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()));
        assert_eq!(
            open_args(Path::new("/tmp/G.app"), env),
            ["--env", "GLADE_APP_IDENTIFIER=dev.x", "--env", "PI_UI_DATA_DIR=/tmp/d", "/tmp/G.app"]
        );
    }
}

//! The shell ↔ server channel for the menu bar and the power assertion (I-147/I-150).
//!
//! A background thread long-polls our server's `GET /api/desktop/state?after=<rev>` (it answers on
//! the next change or after ~25 s, see apps/server/src/services/power.ts) and, on every new state:
//! - holds or releases the IOKit assertion (`power.rs`) as the server's `power.held` says;
//! - rebuilds the menu bar icon and menu (`tray.rs`).
//! While the server can't be reached, the assertion is released (no server, no reason).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::server::{self, ServerState};

/// What the shell needs from `DesktopShellState` (packages/protocol/src/power.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellState {
    pub rev: u64,
    pub working: u32,
    pub needs_you: u32,
    pub sharing_on: bool,
    pub devices: Vec<String>,
    /// The server wants the Mac kept awake (reasons left, and we're the Mac app's server).
    pub held: bool,
    /// The reasons in words ("2 chats are working").
    pub awake_text: String,
}

pub fn parse(body: &str) -> Option<ShellState> {
    let json: Value = serde_json::from_str(body).ok()?;
    let num = |v: Option<&Value>| v.and_then(Value::as_u64).unwrap_or(0) as u32;
    Some(ShellState {
        rev: json.get("rev")?.as_u64()?,
        working: num(json.pointer("/chats/working")),
        needs_you: num(json.pointer("/chats/needsYou")),
        sharing_on: json.pointer("/sharing/on").and_then(Value::as_bool).unwrap_or(false),
        devices: json
            .pointer("/sharing/devices")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|d| d.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        held: json.pointer("/power/held").and_then(Value::as_bool).unwrap_or(false),
        awake_text: json.pointer("/power/text").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

/// The assertion name for a state: `None` = release.
pub fn assertion_name(state: Option<&ShellState>) -> Option<String> {
    let s = state.filter(|s| s.held)?;
    Some(if s.awake_text.is_empty() { "Glade".to_string() } else { format!("Glade: {}", s.awake_text) })
}

static CURRENT: Mutex<Option<ShellState>> = Mutex::new(None);
static STOP: AtomicBool = AtomicBool::new(false);

/// The latest state (None until the server answered, or while it can't be reached).
pub fn current() -> Option<ShellState> {
    CURRENT.lock().unwrap().clone()
}

/// Our server's host and port, once it runs.
pub fn server_target(app: &AppHandle) -> Option<(String, u16)> {
    let state = app.try_state::<ServerState>()?;
    let guard = state.0.lock().unwrap();
    guard.as_ref().map(|s| (s.host().to_string(), s.port))
}

/// Sharing is on right now (`GET /api/auth/remote`).
pub fn sharing_now(app: &AppHandle) -> bool {
    server_target(app)
        .and_then(|(host, port)| server::http_get(&host, port, "/api/auth/remote", Duration::from_secs(5)))
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn apply(app: &AppHandle, state: Option<ShellState>) {
    let changed = {
        let mut current = CURRENT.lock().unwrap();
        let changed = *current != state;
        *current = state.clone();
        changed
    };
    crate::power::set(assertion_name(state.as_ref()).as_deref());
    if changed {
        crate::tray::refresh(app);
    }
}

/// Start polling (once the server runs). Stops with `stop()`.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut rev: Option<u64> = None;
        let mut failures = 0u32;
        while !STOP.load(Ordering::SeqCst) {
            let Some((host, port)) = server_target(&app) else {
                thread::sleep(Duration::from_secs(1));
                continue;
            };
            let path = match rev {
                Some(r) => format!("/api/desktop/state?after={r}"),
                None => "/api/desktop/state".to_string(),
            };
            match server::http_get(&host, port, &path, Duration::from_secs(40)).as_deref().and_then(parse) {
                Some(state) => {
                    failures = 0;
                    rev = Some(state.rev);
                    if !STOP.load(Ordering::SeqCst) {
                        apply(&app, Some(state));
                    }
                }
                None => {
                    failures += 1;
                    rev = None;
                    // A hiccup is fine; a server that stays away holds no reason.
                    if failures >= 3 {
                        apply(&app, None);
                    }
                    thread::sleep(Duration::from_secs(2));
                }
            }
        }
    });
}

/// Stop polling and release the assertion (quit).
pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
    crate::power::release();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_server_state() {
        let body = r#"{"rev":7,"chats":{"working":2,"needsYou":1},"sharing":{"on":true,"devices":["iPhone"]},
            "power":{"reasons":[{"kind":"working","chats":2}],"text":"2 chats are working","held":true,"canHold":true,"powerSource":null,"sharedSkipped":null}}"#;
        let s = parse(body).unwrap();
        assert_eq!(
            s,
            ShellState {
                rev: 7,
                working: 2,
                needs_you: 1,
                sharing_on: true,
                devices: vec!["iPhone".into()],
                held: true,
                awake_text: "2 chats are working".into()
            }
        );
        assert_eq!(assertion_name(Some(&s)).as_deref(), Some("Glade: 2 chats are working"));
        assert_eq!(assertion_name(Some(&ShellState { held: false, ..s })), None);
        assert_eq!(assertion_name(None), None);
        assert_eq!(parse("{}"), None);
        assert_eq!(parse("nope"), None);
    }
}

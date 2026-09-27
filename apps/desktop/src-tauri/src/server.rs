//! The bundled pi-ui server: find the user's `node` and `pi`, start `node server.mjs` on a free
//! loopback port, wait until it answers, and stop it again when the app exits.
//!
//! Apps launched from Finder get a minimal PATH (no nvm/Homebrew), so `node` and `pi` are
//! resolved through the user's login shell, and that shell's PATH is handed to the server so
//! `pi` (a `#!/usr/bin/env node` script) and the tools it runs behave like in a terminal.
//!
//! The app always runs its own server (`PI_UI_SERVER_KIND=desktop`), even when another one
//! (e.g. `pnpm dev`) uses the same data folder: servers share the folder safely (I-062: locked,
//! watched store; session leases; `<dataDir>/servers/<pid>.json` registry), so there's nothing
//! to borrow and quitting the app never stops someone else's server.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

/// Oldest Node major the bundled server supports (esbuild target `node22`).
const MIN_NODE_MAJOR: u32 = 22;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// What we learned from the login shell.
#[derive(Debug, Default)]
pub struct ShellEnv {
    pub node: Option<PathBuf>,
    pub pi: Option<PathBuf>,
    pub path: String,
}

/// Paths of the bundled server inside the app's Resources.
pub struct Bundle {
    pub server_js: PathBuf,
    pub web_dir: PathBuf,
}

pub struct RunningServer {
    pub port: u16,
    child: Child,
    /// Held open for the server's lifetime: the server exits when this pipe closes, so it can't
    /// outlive the app even if the app crashes.
    stdin: Option<ChildStdin>,
}

impl RunningServer {
    pub fn host(&self) -> &str {
        "127.0.0.1"
    }
    pub fn url(&self) -> String {
        format!("http://{}:{}/", self.host(), self.port)
    }
}

/// Managed state: the server we started, if any.
#[derive(Default)]
pub struct ServerState(pub Mutex<Option<RunningServer>>);

const MARK: &str = "__PI_UI_ENV__";

/// Run `$SHELL -ilc` (interactive login, so `.zshrc`-style setups like nvm are loaded) and read
/// `command -v node`, `command -v pi` and `$PATH`. Falls back to `-lc`, then to well-known dirs.
pub fn resolve_shell_env() -> ShellEnv {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!(
        "printf '\\n{m}\\n'; command -v node; printf '{m}\\n'; command -v pi; printf '{m}\\n'; printf '%s\\n' \"$PATH\"; printf '{m}\\n'",
        m = MARK
    );
    let mut env = ["-ilc", "-lc"]
        .iter()
        .find_map(|flags| run_shell(&shell, flags, &script))
        .unwrap_or_default();

    // Make sure the common install locations are searched even if the shell setup is unusual.
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<String> = env.path.split(':').filter(|s| !s.is_empty()).map(String::from).collect();
    for extra in fallback_dirs(&home) {
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    env.node = env.node.filter(|p| is_executable(p)).or_else(|| find_in(&dirs, "node"));
    env.pi = env.pi.filter(|p| is_executable(p)).or_else(|| find_in(&dirs, "pi"));
    // Put the directories of the resolved binaries first so `pi` finds the same `node`.
    for bin in [&env.pi, &env.node].into_iter().flatten() {
        if let Some(dir) = bin.parent().map(|d| d.to_string_lossy().into_owned()) {
            dirs.retain(|d| d != &dir);
            dirs.insert(0, dir);
        }
    }
    env.path = dirs.join(":");
    env
}

fn run_shell(shell: &str, flags: &str, script: &str) -> Option<ShellEnv> {
    let mut child = Command::new(shell)
        .arg(flags)
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    // A broken shell config must not hang the app.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = reader.join().ok()?;
    let parts: Vec<&str> = out.split(MARK).collect();
    // ["<noise>", node, pi, path, "<rest>"]
    if parts.len() < 5 {
        return None;
    }
    let field = |s: &str| s.trim().lines().last().map(str::trim).filter(|l| l.starts_with('/')).map(PathBuf::from);
    Some(ShellEnv {
        node: field(parts[1]),
        pi: field(parts[2]),
        path: parts[3].trim().to_string(),
    })
}

fn fallback_dirs(home: &str) -> Vec<String> {
    let mut dirs = Vec::new();
    // nvm: newest installed version first.
    if let Ok(entries) = fs::read_dir(format!("{home}/.nvm/versions/node")) {
        let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        versions.sort_by_key(|p| std::cmp::Reverse(version_key(p)));
        dirs.extend(versions.iter().map(|v| v.join("bin").to_string_lossy().into_owned()));
    }
    for d in [
        format!("{home}/.volta/bin"),
        format!("{home}/.local/bin"),
        format!("{home}/.bun/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
        "/usr/sbin".into(),
        "/sbin".into(),
    ] {
        dirs.push(d);
    }
    dirs
}

fn version_key(p: &Path) -> Vec<u32> {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    name.trim_start_matches('v').split('.').map(|s| s.parse().unwrap_or(0)).collect()
}

fn find_in(dirs: &[String], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| Path::new(d).join(name)).find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// The user may point pi-ui at pi explicitly (Settings → Agent → pi path); honour that when
/// `pi` isn't on PATH.
fn configured_pi_path() -> Option<PathBuf> {
    let text = fs::read_to_string(data_dir().join("settings.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let path = PathBuf::from(json.get("agent")?.get("piPath")?.as_str()?);
    (path.is_absolute() && is_executable(&path)).then_some(path)
}

fn node_major(node: &Path, path: &str) -> Option<u32> {
    let out = Command::new(node).arg("--version").env("PATH", path).output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout);
    v.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

/// pi-ui's data folder (same rule as the server's `defaultDataDir` on macOS).
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_UI_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join("Library").join("Application Support").join("pi-ui")
}

/// `GET path` on a loopback server; returns the body of a 200 response. HTTP/1.0 so the
/// response is never chunked.
pub fn http_get(host: &str, port: u16, path: &str, timeout: Duration) -> Option<String> {
    let addr = (host, port).to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(300)).ok()?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req = format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.lines().next()?;
    status.split_whitespace().nth(1).filter(|c| *c == "200")?;
    Some(body.to_string())
}

/// True once `GET /api/settings` answers 200.
fn answers(host: &str, port: u16) -> bool {
    http_get(host, port, "/api/settings", Duration::from_secs(2)).is_some()
}

/// Number of chats (workspaces) with a session that is `working` or `blocked` **on this server**,
/// or None if it can't be asked. Sessions another server runs (`activeElsewhere`, I-062) don't
/// count: quitting the app doesn't stop them.
pub fn busy_chats(host: &str, port: u16) -> Option<usize> {
    let body = http_get(host, port, "/api/sessions", Duration::from_millis(1500))?;
    count_busy(&body)
}

fn count_busy(body: &str) -> Option<usize> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let sessions = json.as_array()?;
    let busy: std::collections::HashSet<&str> = sessions
        .iter()
        .filter(|s| matches!(s.get("status").and_then(|v| v.as_str()), Some("working" | "blocked")))
        .filter(|s| s.get("activeElsewhere").is_none_or(|v| v.is_null()))
        .filter_map(|s| s.get("workspaceId").and_then(|v| v.as_str()))
        .collect();
    Some(busy.len())
}

fn log_tail(log: &Path) -> String {
    let text = fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}

/// Start our server on a free port and wait until it serves requests. Errors are user-facing
/// messages.
pub fn start(bundle: &Bundle, log_path: &Path) -> Result<RunningServer, String> {
    if !bundle.server_js.exists() {
        return Err(format!("The bundled server is missing:\n{}", bundle.server_js.display()));
    }
    let env = resolve_shell_env();
    let Some(node) = env.node.clone() else {
        return Err(format!(
            "Node.js wasn't found.\n\npi-ui runs its server with your own Node.js (≥ {MIN_NODE_MAJOR}), the one pi uses. \
             Install it (e.g. with nvm or Homebrew) so that `command -v node` works in a new terminal, then reopen pi-ui."
        ));
    };
    if let Some(major) = node_major(&node, &env.path) {
        if major < MIN_NODE_MAJOR {
            return Err(format!(
                "Node.js {major} is too old ({}).\n\npi-ui needs Node.js {MIN_NODE_MAJOR} or newer.",
                node.display()
            ));
        }
    }
    let pi = env.pi.clone().or_else(configured_pi_path);
    if pi.is_none() {
        return Err(
            "pi wasn't found.\n\nInstall it with `npm install -g @earendil-works/pi-coding-agent` (or make sure `command -v pi` \
             works in a new terminal), or set an absolute pi path in pi-ui's settings, then reopen pi-ui."
                .into(),
        );
    }

    let port = free_port().map_err(|e| format!("Couldn't find a free port: {e}"))?;
    if let Some(dir) = log_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let log = File::create(log_path).map_err(|e| format!("Couldn't create {}: {e}", log_path.display()))?;
    let mut cmd = Command::new(&node);
    cmd.arg(&bundle.server_js)
        .current_dir(bundle.server_js.parent().unwrap_or(Path::new("/")))
        .env("PATH", &env.path)
        .env("PI_UI_PORT", port.to_string())
        .env("PI_UI_HOST", "127.0.0.1")
        .env("PI_UI_STATIC_DIR", &bundle.web_dir)
        .env("PI_UI_EXIT_ON_STDIN_CLOSE", "1")
        .env("PI_UI_SERVER_KIND", "desktop")
        .stdin(Stdio::piped())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    // Don't leak a dev-mode harness choice from the launching environment.
    cmd.env_remove("PI_UI_HARNESS");
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {}: {e}", node.display()))?;
    let stdin = child.stdin.take();
    let mut server = RunningServer { port, child, stdin };

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Ok(Some(status)) = server.child.try_wait() {
            return Err(format!(
                "The pi-ui server exited during startup ({status}).\n\n{}\n\nLog: {}",
                log_tail(log_path),
                log_path.display()
            ));
        }
        if answers("127.0.0.1", port) {
            return Ok(server);
        }
        if Instant::now() > deadline {
            server.stop();
            return Err(format!(
                "The pi-ui server didn't respond within {}s.\n\n{}\n\nLog: {}",
                STARTUP_TIMEOUT.as_secs(),
                log_tail(log_path),
                log_path.display()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

impl RunningServer {
    /// Graceful stop: SIGTERM (the server closes its pi processes and flushes data), then kill.
    pub fn stop(&mut self) {
        if let Ok(Some(_)) = self.child.try_wait() {
            return;
        }
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                self.stdin.take();
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.stdin.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_busy_chats() {
        let body = r#"[
            {"workspaceId":"a","status":"working"},
            {"workspaceId":"a","status":"blocked"},
            {"workspaceId":"b","status":"idle"},
            {"workspaceId":"c","status":"blocked"},
            {"workspaceId":"d","status":"unread"},
            {"workspaceId":"e","status":"working","activeElsewhere":{"serverKind":"dev","since":1}}
        ]"#;
        // One per workspace; sessions running in another server don't count.
        assert_eq!(count_busy(body), Some(2));
        assert_eq!(count_busy("[]"), Some(0));
        assert_eq!(count_busy("{}"), None);
    }
}

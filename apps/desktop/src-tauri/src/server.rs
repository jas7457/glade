//! The bundled pi-ui server: find the user's `node` and `pi`, start `node server.mjs` on a free
//! loopback port, wait until it answers, and stop it again when the app exits.
//!
//! Apps launched from Finder get a minimal PATH (no nvm/Homebrew), so `node` and `pi` are
//! resolved through the user's login shell, and that shell's PATH is handed to the server so
//! `pi` (a `#!/usr/bin/env node` script) and the tools it runs behave like in a terminal.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
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

/// Managed state: the running server, if any.
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
    let home = std::env::var("HOME").ok()?;
    let data_dir = std::env::var("PI_UI_DATA_DIR")
        .unwrap_or_else(|_| format!("{home}/Library/Application Support/pi-ui"));
    let text = fs::read_to_string(Path::new(&data_dir).join("settings.json")).ok()?;
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

/// True once `GET /api/settings` answers 200.
fn answers(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET /api/settings HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 16];
    let n = stream.read(&mut head).unwrap_or(0);
    String::from_utf8_lossy(&head[..n]).starts_with("HTTP/1.1 200")
}

fn log_tail(log: &Path) -> String {
    let text = fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}

/// Start the server and wait until it serves requests. Errors are user-facing messages.
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
        if answers(port) {
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

//! External links (I-129): the main webview never leaves the app.
//!
//! - `on_navigation`: the app's own pages (bundled splash, Vite dev server, the local Glade server
//!   on any loopback port) load as usual; an http/https/mailto URL anywhere else opens in the
//!   default browser / mail app and the navigation is cancelled; anything else is just cancelled.
//! - `on_new_window` (`target=_blank`, `window.open`, "Open Link in New Window"): never creates a
//!   window; http/https/mailto URLs open in the default app instead.
//!
//! The web app also intercepts link clicks itself (apps/web/src/lib/external-links.ts) and calls
//! the opener plugin from JS; this is the safety net for everything that slips past it.

use tauri::{webview::NewWindowResponse, Runtime, Url};

/// Pages the main webview may show.
pub fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        // Bundled splash (tauri://localhost / http://tauri.localhost), about:blank, in-page
        // blobs/data (downloads, previews).
        "tauri" | "asset" | "about" | "blob" | "data" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "tauri.localhost" | "asset.localhost")
        ),
        _ => false,
    }
}

/// URLs we hand to the default app (browser, mail).
pub fn is_openable_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn open_external(url: &Url) {
    if is_openable_external(url) {
        if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
            eprintln!("[glade] couldn't open {url}: {e}");
        }
    }
}

/// `on_navigation` handler: `true` lets the webview navigate.
pub fn on_navigation(url: &Url) -> bool {
    if is_app_url(url) {
        return true;
    }
    open_external(url);
    false
}

/// `on_new_window` handler: open outside, never in a new app window.
pub fn on_new_window<R: Runtime>(url: Url) -> NewWindowResponse<R> {
    open_external(&url);
    NewWindowResponse::Deny
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn app_pages_stay_in_the_webview() {
        for s in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://127.0.0.1:4317/chats/abc",
            "http://localhost:5317/",
            "http://[::1]:4000/",
            "about:blank",
            "blob:http://127.0.0.1:4317/1234",
        ] {
            assert!(is_app_url(&url(s)), "{s}");
        }
    }

    #[test]
    fn everything_else_leaves_the_webview() {
        for s in [
            "https://login.tailscale.com/admin/dns",
            "http://example.com/",
            "https://127.0.0.1.evil.com/",
            "http://localhost.evil.com/",
            "mailto:someone@example.com",
            "file:///etc/passwd",
        ] {
            assert!(!is_app_url(&url(s)), "{s}");
        }
    }

    #[test]
    fn only_web_and_mail_links_open_outside() {
        assert!(is_openable_external(&url("https://example.com/")));
        assert!(is_openable_external(&url("http://example.com/")));
        assert!(is_openable_external(&url("mailto:a@b.c")));
        assert!(!is_openable_external(&url("file:///Applications/Calculator.app")));
        assert!(!is_openable_external(&url("javascript:alert(1)")));
        assert!(!is_openable_external(&url("tel:123")));
    }
}

//! Navigation guard: the window only navigates within the app origin. A link in an email must never take the
//! webview to the sender's site; links open in the system browser (`link`).
//!
//! Behaviour verified against tauri 2.12 / wry 0.57:
//! - `plugin::Builder::on_navigation` runs for every webview, and returning `false` cancels the navigation.
//! - The app origin is `tauri://localhost` on Linux/macOS and `http(s)://tauri.localhost` on Windows/Android. Under
//!   desktop `tauri dev` the webview loads `devUrl` as is.
//! - WebKitGTK reports every `NavigationAction`, probably including subframes, so `about:srcdoc`/`about:blank` are
//!   allowed (the reader is a `srcdoc` iframe). WebView2 only hooks `NavigationStarting` (main frame).
//! - A URL wry cannot parse is allowed; that is outside our control.
//! - New windows are denied by default: Tauri only hooks wry when `on_new_window` is set (it is not here), WebView2
//!   then marks the request as handled and WebKitGTK never creates the window. The reader iframe is also
//!   `sandbox=""` (no popups).

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use url::Url;

/// Origins Tauri serves the app from on this platform (see the module docs).
const APP_ORIGINS: &[&str] =
    if cfg!(any(windows, target_os = "android")) { &["http://tauri.localhost", "https://tauri.localhost"] } else { &["tauri://localhost"] };

/// `scheme://host[:port]`, built by hand because the `url` crate gives `tauri:` an opaque origin.
fn origin(url: &Url) -> Option<String> {
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{}://{}{port}", url.scheme(), url.host_str()?))
}

/// Whether the webview may navigate to `url`: the app origin, `about:blank`/`about:srcdoc` and, when given (only
/// under `tauri dev`), the dev server origin. Everything else is denied.
pub fn is_app_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
    // Match scheme and path, not the whole string: `about:srcdoc#…` is still the reader and must not go blank.
    if url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc") {
        return true;
    }
    let Some(here) = origin(url) else { return false };
    APP_ORIGINS.contains(&here.as_str()) || dev_url.and_then(origin).is_some_and(|dev| dev == here)
}

/// Internal plugin applying [`is_app_navigation`]; logs one stderr line per denial (scheme only).
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("nav-guard")
        .on_navigation(|webview, url| {
            let dev_url = if cfg!(dev) { webview.config().build.dev_url.clone() } else { None };
            let allowed = is_app_navigation(url, dev_url.as_ref());
            if !allowed {
                eprintln!("[nav-guard] navigation blocked (scheme {:.16})", url.scheme());
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nav(url: &str, dev: Option<&str>) -> bool {
        let dev = dev.map(|d| Url::parse(d).unwrap());
        is_app_navigation(&Url::parse(url).unwrap(), dev.as_ref())
    }

    #[test]
    fn allows_the_app_origin_of_this_platform() {
        for origin in APP_ORIGINS {
            assert!(nav(&format!("{origin}/"), None), "{origin}");
            assert!(nav(&format!("{origin}/index.html#/inbox"), None), "{origin}");
        }
    }

    #[cfg(not(any(windows, target_os = "android")))]
    #[test]
    fn linux_and_macos_use_the_tauri_scheme_only() {
        assert!(nav("tauri://localhost", None));
        assert!(!nav("http://tauri.localhost/", None));
        assert!(!nav("https://tauri.localhost/", None));
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_tauri_localhost_only() {
        assert!(nav("http://tauri.localhost/", None));
        assert!(nav("https://tauri.localhost/", None));
        assert!(!nav("tauri://localhost", None));
    }

    #[test]
    fn allows_the_reader_iframe_documents() {
        assert!(nav("about:srcdoc", None));
        assert!(nav("about:blank", None));
        // A fragment or query is still the same document; the reader must not go blank.
        assert!(nav("about:blank#x", None));
        assert!(nav("about:srcdoc#top", None));
        assert!(nav("about:srcdoc?x", None));
    }

    #[test]
    fn allows_the_dev_server_only_when_given() {
        let dev = Some("http://localhost:5173/");
        assert!(nav("http://localhost:5173/", dev));
        assert!(nav("http://localhost:5173/src/main.tsx", dev));
        assert!(!nav("http://localhost:5173/", None));
        assert!(!nav("http://localhost:5174/", dev));
        assert!(!nav("https://localhost:5173/", dev));
        assert!(!nav("http://127.0.0.1:5173/", dev));
    }

    #[test]
    fn denies_everything_else() {
        for url in [
            "https://example.com/",
            "http://example.com/",
            "https://tauri.localhost.evil.com/",
            "tauri://evil/",
            "tauri://localhost:8080/",
            "http://tauri.localhost:8080/",
            "about:config",
            "about:srcdocx",
            "about:blank/x",
            "tauri://localhost@evil/",
            "TAURI://evil/",
            "TAURI://LOCALHOST/",
            "tauri://localhost.evil/",
            "file:///etc/passwd",
            "data:text/html,hola",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "blob:tauri://localhost/x",
        ] {
            assert!(!nav(url, Some("http://localhost:5173/")), "{url}");
        }
    }
}

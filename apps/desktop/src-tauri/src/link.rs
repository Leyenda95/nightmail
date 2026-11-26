//! Links in emails. A single validation decides both what the confirmation dialog shows and what is opened in the
//! system browser. Everything fails closed: when in doubt, the link is not opened.
//!
//! The UI calls [`inspect_link`] to show the normalised URL and, after confirmation, `open_link`, which validates
//! again and opens exactly [`LinkInfo::url`]. Errors are fixed codes and never include the URL.

use serde::Serialize;
use ts_rs::TS;
use std::net::{Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

/// Maximum link length in bytes, before and after normalisation.
const MAX_LEN: usize = 4096;

/// An accepted link: what the confirmation shows is what gets opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct LinkInfo {
    /// Normalised form (ASCII/punycode host, percent-encoded path).
    pub url: String,
    /// ASCII host, with the port if it is not the scheme default.
    pub host: String,
    /// `https`; for `http` the UI warns that the connection is not encrypted.
    pub secure: bool,
}

/// Why a link is not opened. Each code maps to a fixed message (`errors.ts`) and never includes the URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum LinkError {
    /// Longer than [`MAX_LEN`] bytes.
    LinkTooLong,
    /// Control characters, inner whitespace, or bidi/invisible characters.
    LinkHiddenChars,
    /// Not a URL, or no host.
    LinkMalformed,
    /// Scheme other than `https`/`http` (`mailto:`, `file:`, `javascript:`…).
    LinkScheme,
    /// Contains a user or password (`https://bank.com@evil.com`).
    LinkCredentials,
    /// Points to this machine or a local/private network (`localhost`, `192.168.…`, `http://printer/`…).
    LinkLocal,
    /// The OS could not open the browser.
    BrowserFailed,
}

/// Characters that can disguise what the user sees: bidi controls, zero-width, soft hyphen, tags and annotation anchors.
fn is_hidden(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2069}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

/// Checks the input as received (no inner trimming), before the `url` crate cleans it up.
fn check_raw(trimmed: &str) -> Result<(), LinkError> {
    if trimmed.len() > MAX_LEN {
        return Err(LinkError::LinkTooLong);
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace() || is_hidden(c)) {
        return Err(LinkError::LinkHiddenChars);
    }
    Ok(())
}

/// ASCII `host[:port]`; the `url` crate already omits the scheme's default port.
fn host_label(url: &Url) -> Result<String, LinkError> {
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or(LinkError::LinkMalformed)?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

/// `https` is encrypted, `http` is not, any other scheme is rejected.
fn is_secure(url: &Url) -> Result<bool, LinkError> {
    match url.scheme() {
        "https" => Ok(true),
        "http" => Ok(false),
        _ => Err(LinkError::LinkScheme),
    }
}

/// Name suffixes that only exist on this machine or the local network.
const LOCAL_SUFFIXES: &[&str] = &[".localhost", ".local", ".localdomain", ".internal", ".lan", ".home.arpa"];

/// Local name: no dot, `localhost`, or a local suffix (after dropping trailing dots, so `localhost.` matches too).
fn is_local_domain(domain: &str) -> bool {
    let name = domain.trim_end_matches('.');
    !name.contains('.') || name == "localhost" || LOCAL_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// Non-public IPv4: loopback, private, link-local, CGNAT, reserved, multicast and broadcast.
fn is_local_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    matches!(
        (a, b, c),
        (0 | 10 | 127, _, _)
            | (172, 16..=31, _)
            | (192, 168, _)
            | (169, 254, _)
            | (100, 64..=127, _)
            | (192, 0, 0)
            | (198, 18..=19, _)
            | (224..=255, _, _)
    )
}

/// Non-public IPv6. Only global unicast (`2000::/3`) is accepted, minus 6to4, Teredo and documentation ranges; this
/// also rejects IPv4-mapped/compatible addresses (`::ffff:127.0.0.1`) and NAT64.
fn is_local_ipv6(ip: Ipv6Addr) -> bool {
    let [s0, s1, ..] = ip.segments();
    s0 & 0xe000 != 0x2000 || s0 == 0x2002 || (s0 == 0x2001 && (s1 == 0 || s1 == 0x0db8))
}

/// Rejects destinations on this machine or a local/private network. Works on the host as already parsed by the
/// crate (decimal, octal or hex IPs arrive here as IPv4). Public names resolving to a local IP are not caught.
fn check_public_host(url: &Url) -> Result<(), LinkError> {
    let local = match url.host() {
        Some(Host::Domain(d)) => is_local_domain(d),
        Some(Host::Ipv4(ip)) => is_local_ipv4(ip),
        Some(Host::Ipv6(ip)) => is_local_ipv6(ip),
        None => return Err(LinkError::LinkMalformed),
    };
    if local { Err(LinkError::LinkLocal) } else { Ok(()) }
}

/// Validates and normalises a link. Single source of truth for what is shown and what is opened.
pub fn inspect_link(raw: &str) -> Result<LinkInfo, LinkError> {
    let trimmed = raw.trim();
    check_raw(trimmed)?;
    let url = Url::parse(trimmed).map_err(|_| LinkError::LinkMalformed)?;
    let secure = is_secure(&url)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(LinkError::LinkCredentials);
    }
    check_public_host(&url)?;
    let host = host_label(&url)?;
    let url = String::from(url);
    if url.len() > MAX_LEN {
        return Err(LinkError::LinkTooLong);
    }
    Ok(LinkInfo { url, host, secure })
}

/// Validates again and opens exactly the normalised URL with `open` (injectable so tests do not launch a browser).
pub fn open_checked<E>(raw: &str, open: impl FnOnce(&str) -> Result<(), E>) -> Result<(), LinkError> {
    let info = inspect_link(raw)?;
    open(&info.url).map_err(|_| LinkError::BrowserFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) -> LinkInfo {
        inspect_link(raw).unwrap_or_else(|e| panic!("{raw:?} → {e:?}"))
    }

    #[test]
    fn accepts_web_links_and_normalizes_them() {
        let cases = [
            ("https://example.com", "https://example.com/", "example.com", true),
            ("http://Example.COM/ab", "http://example.com/ab", "example.com", false),
            ("https://example.com:443/x", "https://example.com/x", "example.com", true),
            ("https://example.com:8443/x?q=1#f", "https://example.com:8443/x?q=1#f", "example.com:8443", true),
            ("https://bücher.example/ñ", "https://xn--bcher-kva.example/%C3%B1", "xn--bcher-kva.example", true),
            ("https://[2606:4700::1111]:8080/", "https://[2606:4700::1111]:8080/", "[2606:4700::1111]:8080", true),
            ("\n https://example.com/t \t", "https://example.com/t", "example.com", true),
            // Odd forms that the crate normalises before anything is shown.
            ("https://banco.com\\@evil.com", "https://banco.com/@evil.com", "banco.com", true),
            ("https:example.com", "https://example.com/", "example.com", true),
            ("http://0x5d.0xb8.0xd8.0x22/", "http://93.184.216.34/", "93.184.216.34", false),
            ("http://1572395042/", "http://93.184.216.34/", "93.184.216.34", false),
            ("http://0135.0270.0330.042/", "http://93.184.216.34/", "93.184.216.34", false),
            ("https://ex%61mple.com/", "https://example.com/", "example.com", true),
            ("https://example.com./", "https://example.com./", "example.com.", true),
            ("http://172.32.0.1/", "http://172.32.0.1/", "172.32.0.1", false),
            ("http://100.128.0.1/", "http://100.128.0.1/", "100.128.0.1", false),
        ];
        for (raw, url, host, secure) in cases {
            let info = ok(raw);
            assert_eq!(info, LinkInfo { url: url.into(), host: host.into(), secure }, "{raw:?}");
            // Idempotent and ASCII-only: what was confirmed yields the same result when opened.
            assert_eq!(ok(&info.url), info, "{raw:?}");
            assert!(info.url.is_ascii() && info.host.is_ascii(), "{raw:?}");
        }
    }

    #[test]
    fn rejects_local_and_private_destinations() {
        for raw in [
            // Local or dotless names, with and without trailing dots.
            "http://localhost/",
            "http://localhost./",
            "http://LOCALHOST:8080/",
            "http://a.localhost/",
            "http://impresora/",
            "http://impresora./",
            "http://nas.local/",
            "http://router.localdomain/",
            "http://api.internal/",
            "http://pc.lan/",
            "http://casa.home.arpa/",
            "http://casa.home.arpa../",
            // IPv4 ranges, plus the decimal/octal/hex/short forms the crate turns into IPv4.
            "http://0/",
            "http://0.0.0.0/",
            "http://0.255.255.255/",
            "http://127.0.0.1:6300/",
            "http://127.255.255.254/",
            "http://0x7f.1/",
            "http://2130706433/",
            "http://017700000001/",
            "http://10.0.0.1/",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://192.168.1.1/",
            "http://169.254.169.254/",
            "http://100.64.0.1/",
            "http://100.127.255.255/",
            "http://192.0.0.8/",
            "http://198.18.0.1/",
            "http://198.19.255.255/",
            "http://224.0.0.1/",
            "http://239.255.255.250/",
            "http://240.0.0.1/",
            "http://255.255.255.255/",
            // IPv6: anything that is not global unicast, plus 6to4, Teredo and documentation inside it.
            "https://[::1]:8080/",
            "http://[::]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:7f00:1]/",
            "http://[::ffff:8.8.8.8]/",
            "http://[::127.0.0.1]/",
            "http://[64:ff9b::7f00:1]/",
            "http://[fc00::1]/",
            "http://[fd12:3456::1]/",
            "http://[fe80::1]/",
            "http://[ff02::1]/",
            "http://[2002:7f00:1::1]/",
            "http://[2001:0:4136:e378::1]/",
            "http://[2001:db8::1]/",
            "http://[4000::1]/",
        ] {
            assert_eq!(inspect_link(raw), Err(LinkError::LinkLocal), "{raw}");
        }
    }

    #[test]
    fn accepts_public_addresses_next_to_the_private_ranges() {
        for raw in [
            "http://1.0.0.1/",
            "http://11.0.0.1/",
            "http://126.255.255.255/",
            "http://128.0.0.1/",
            "http://172.15.255.255/",
            "http://192.167.255.255/",
            "http://192.169.0.1/",
            "http://169.253.0.1/",
            "http://100.63.255.255/",
            "http://192.0.1.1/",
            "http://198.17.255.255/",
            "http://198.20.0.1/",
            "http://223.255.255.255/",
            "http://[2001:4860:4860::8888]/",
            "http://[2001:1::1]/",
            "http://[2003::1]/",
            "http://[3fff:ffff::1]/",
            "https://local.example/",
            "https://lan.example.com/",
            "https://mi.localhost.example/",
        ] {
            assert!(inspect_link(raw).is_ok(), "{raw}");
        }
    }

    #[test]
    fn rejects_other_schemes() {
        for raw in [
            "mailto:a@b.c",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hola",
            "tel:+34600000000",
            "ftp://example.com/",
            "nightmail://x",
            "tauri://localhost/",
            "blob:https://example.com/x",
        ] {
            assert_eq!(inspect_link(raw), Err(LinkError::LinkScheme), "{raw}");
        }
    }

    #[test]
    fn rejects_credentials() {
        for raw in ["https://banco.com@malo.com/", "https://user:pass@example.com/", "http://:pw@example.com/"] {
            assert_eq!(inspect_link(raw), Err(LinkError::LinkCredentials), "{raw}");
        }
    }

    #[test]
    fn rejects_hidden_and_control_characters() {
        for raw in [
            "https://example.com/a b",
            "https://exa\u{200B}mple.com/",
            "https://example.com/\u{202E}gpj.exe",
            "https://example.com/\u{2066}x",
            "\u{FEFF}https://example.com/",
            "https://example.com/\u{00AD}",
            "https://example.com/\u{E0041}",
            "https://example.com/\u{0007}",
            "https://exam\tple.com/",
            "https://example.com/\nx",
            "https://example.com/\u{00A0}x",
        ] {
            assert_eq!(inspect_link(raw), Err(LinkError::LinkHiddenChars), "{raw:?}");
        }
    }

    #[test]
    fn rejects_malformed() {
        for raw in ["", "   ", "example.com", "https://", "https://exa mple", "http://[::1", "https://ex%00ample.com/"] {
            let e = inspect_link(raw).unwrap_err();
            assert!(matches!(e, LinkError::LinkMalformed | LinkError::LinkHiddenChars), "{raw:?} → {e:?}");
        }
        assert_eq!(inspect_link("https://"), Err(LinkError::LinkMalformed));
        assert_eq!(inspect_link("example.com"), Err(LinkError::LinkMalformed));
    }

    #[test]
    fn rejects_too_long_before_and_after_normalizing() {
        let path = "a".repeat(MAX_LEN);
        assert_eq!(inspect_link(&format!("https://example.com/{path}")), Err(LinkError::LinkTooLong));
        let just = format!("https://example.com/{}", "a".repeat(MAX_LEN - 20));
        assert_eq!(just.len(), MAX_LEN);
        assert!(inspect_link(&just).is_ok());
        // Fits as received, but not after percent-encoding (ñ becomes %C3%B1).
        let grows = format!("https://example.com/{}", "ñ".repeat(1500));
        assert!(grows.len() <= MAX_LEN);
        assert_eq!(inspect_link(&grows), Err(LinkError::LinkTooLong));
    }

    #[test]
    fn errors_never_carry_the_url() {
        let json = serde_json::to_string(&inspect_link("https://banco.com@malo.com/").unwrap_err()).unwrap();
        assert_eq!(json, r#"{"code":"linkCredentials"}"#);
        assert_eq!(serde_json::to_string(&LinkError::BrowserFailed).unwrap(), r#"{"code":"browserFailed"}"#);
        assert_eq!(serde_json::to_string(&LinkError::LinkLocal).unwrap(), r#"{"code":"linkLocal"}"#);
    }

    #[test]
    fn open_checked_opens_exactly_the_normalized_url() {
        let mut opened = Vec::new();
        let result = open_checked(" https://Bücher.example/ñ ", |url| {
            opened.push(url.to_owned());
            Ok::<(), ()>(())
        });
        assert_eq!(result, Ok(()));
        assert_eq!(opened, ["https://xn--bcher-kva.example/%C3%B1"]);
    }

    #[test]
    fn open_checked_never_opens_a_rejected_link() {
        for raw in ["javascript:alert(1)", "https://a@b.c/", "file:///etc/passwd", "https://x.y/\u{202E}", "http://127.0.0.1/"] {
            let mut called = false;
            let result = open_checked(raw, |_| {
                called = true;
                Ok::<(), ()>(())
            });
            assert!(result.is_err(), "{raw:?}");
            assert!(!called, "{raw:?}");
        }
    }

    #[test]
    fn open_checked_reports_a_fixed_error_when_the_browser_fails() {
        assert_eq!(open_checked("https://example.com/", |_| Err("system detail")), Err(LinkError::BrowserFailed));
    }
}

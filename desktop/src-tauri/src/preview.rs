// Privacy-preserving link previews. The SENDER's device fetches a page when a link is typed; the preview then
// travels inside the end-to-end encrypted message, so receivers never contact the website.
//
// Two commands cross from the page to the shell: `fetch_preview` (HTML of a page, at most 512 KB) and
// `fetch_preview_image` (an image, at most 300 KB). Parsing, resizing and re-encoding happen in the page.
//
// Guard against server-side request forgery (a link that points into the sender's own network):
//  * only http and https, at most 3 redirects, 5 second total timeout, no cookies, a generic User-Agent;
//  * the guard sits INSIDE name resolution (`GuardResolver`), so it covers the first request, every redirect and
//    IP-literal hosts, and the address that was checked is the address that is connected to (no DNS rebinding);
//  * any address in a loopback, private, link-local, shared (CGNAT), unique-local or otherwise non-public range
//    is refused. A host with a mix of public and private answers keeps only the public ones.
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use ureq::config::Config;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::NextTimeout;
use ureq::http::Uri;
use ureq::{Agent, ResponseExt};

const MAX_HTML: u64 = 512 * 1024;
const MAX_IMAGE: u64 = 300 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
const USER_AGENT: &str = "Mozilla/5.0 (compatible; LinkPreview/1.0)";

/// True only for addresses that belong to the public internet.
pub fn ip_allowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_allowed(v4),
        IpAddr::V6(v6) => v6_allowed(v6),
    }
}

fn v4_allowed(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0                                   // 0.0.0.0/8 "this network"
        || a == 10                             // 10/8
        || a == 127                            // loopback
        || (a == 100 && (64..=127).contains(&b)) // 100.64/10 shared address space
        || (a == 169 && b == 254)              // link-local
        || (a == 172 && (16..=31).contains(&b)) // 172.16/12
        || (a == 192 && b == 168)              // 192.168/16
        || (a == 192 && b == 0 && c == 0)      // 192.0.0/24 protocol assignments
        || (a == 192 && b == 0 && c == 2)      // documentation
        || (a == 198 && (b == 18 || b == 19))  // benchmarking
        || (a == 198 && b == 51 && c == 100)   // documentation
        || (a == 203 && b == 0 && c == 113)    // documentation
        || a >= 224) // multicast, reserved, broadcast
}

fn v6_allowed(ip: Ipv6Addr) -> bool {
    // An IPv4 address wrapped in IPv6 (::ffff:a.b.c.d, or the deprecated ::a.b.c.d) is judged as IPv4.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_allowed(v4);
    }
    let s = ip.segments();
    if s[..6] == [0, 0, 0, 0, 0, 0] {
        return false; // ::, ::1 and IPv4-compatible
    }
    // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address.
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        let v4 = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
        return v4_allowed(v4);
    }
    !((s[0] & 0xfe00) == 0xfc00      // fc00::/7 unique local
        || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
        || (s[0] & 0xffc0) == 0xfec0 // fec0::/10 site-local (deprecated)
        || (s[0] & 0xff00) == 0xff00 // multicast
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        || s[0] == 0x2002) // 6to4 can embed private IPv4
}

#[derive(Debug)]
struct GuardResolver;

impl Resolver for GuardResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let scheme = uri.scheme_str().unwrap_or("");
        let authority = uri.authority().ok_or(ureq::Error::HostNotFound)?;
        let port = authority
            .port_u16()
            .unwrap_or(if scheme == "https" { 443 } else { 80 });
        let host = authority.host().trim_start_matches('[').trim_end_matches(']');
        let _ = (config, timeout); // the whole request already has a 5 s limit
        let found: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
            vec![SocketAddr::new(ip, port)]
        } else {
            (host, port).to_socket_addrs().map_err(ureq::Error::Io)?.collect()
        };
        let mut out = self.empty();
        for addr in found.into_iter().filter(|a| ip_allowed(a.ip())).take(16) {
            out.push(addr);
        }
        if out.is_empty() {
            return Err(ureq::Error::HostNotFound);
        }
        Ok(out)
    }
}

fn agent() -> Agent {
    let config = Config::builder()
        .https_only(false)
        .max_redirects(3)
        .timeout_global(Some(TIMEOUT))
        .user_agent(USER_AGENT)
        .proxy(None)
        .http_status_as_error(true)
        .build();
    Agent::with_parts(config, ureq::unversioned::transport::DefaultConnector::default(), GuardResolver)
}

/// Fetches one URL and returns (final address, content type, body). Refuses a body over `limit`.
fn get(url: &str, accept: &str, limit: u64, want: fn(&str) -> bool) -> Result<(String, Vec<u8>), String> {
    let parsed: Uri = url.parse().map_err(|_| "bad url".to_string())?;
    match parsed.scheme_str() {
        Some("http") | Some("https") => {}
        _ => return Err("only http and https".into()),
    }
    if url.len() > 2048 {
        return Err("url too long".into());
    }
    let mut res = agent()
        .get(url)
        .header("Accept", accept)
        .header("Accept-Language", "en")
        .call()
        .map_err(|e| format!("fetch failed: {e}"))?;
    let kind = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !want(&kind) {
        return Err("unsupported content type".into());
    }
    if let Some(len) = res.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()) {
        if len > limit {
            return Err("too large".into());
        }
    }
    let final_url = res.get_uri().to_string();
    let mut body = Vec::new();
    // Read one byte past the limit so an oversized body is told from one that fits exactly.
    res.body_mut()
        .as_reader()
        .take(limit + 1)
        .read_to_end(&mut body)
        .map_err(|e| format!("read failed: {e}"))?;
    if body.len() as u64 > limit {
        // HTML is allowed to be cut: titles and meta tags live at the top. Images are not.
        if limit == MAX_HTML {
            body.truncate(limit as usize);
        } else {
            return Err("too large".into());
        }
    }
    Ok((final_url, body))
}

fn is_html(kind: &str) -> bool {
    kind.starts_with("text/html") || kind.starts_with("application/xhtml")
}
fn is_image(kind: &str) -> bool {
    matches!(kind.split(';').next().unwrap_or("").trim(), "image/jpeg" | "image/png" | "image/webp" | "image/gif")
}

#[derive(Serialize)]
pub struct Page {
    /// The address after redirects.
    url: String,
    /// The first 512 KB of the page, decoded as UTF-8 (invalid bytes replaced).
    html: String,
}

#[tauri::command]
pub async fn fetch_preview(url: String) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (url, body) = get(&url, "text/html,application/xhtml+xml", MAX_HTML, is_html)?;
        Ok(Page { url, html: String::from_utf8_lossy(&body).into_owned() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The image as base64; the page decodes, shrinks and re-encodes it (which also drops all metadata).
#[tauri::command]
pub async fn fetch_preview_image(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, body) = get(&url, "image/webp,image/png,image/jpeg,image/gif", MAX_IMAGE, is_image)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(body))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> bool {
        ip_allowed(s.parse().unwrap())
    }

    #[test]
    fn blocks_private_and_special_v4() {
        for s in [
            "127.0.0.1", "127.255.255.255", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255",
            "192.168.0.1", "192.168.255.255", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0",
            "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.0.1",
        ] {
            assert!(!ok(s), "{s} must be blocked");
        }
    }

    #[test]
    fn allows_public_v4() {
        for s in ["1.1.1.1", "8.8.8.8", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "193.0.0.1"] {
            assert!(ok(s), "{s} must be allowed");
        }
    }

    #[test]
    fn blocks_private_and_special_v6() {
        for s in ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:192.168.1.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:db8::1"] {
            assert!(!ok(s), "{s} must be blocked");
        }
    }

    #[test]
    fn allows_public_v6() {
        for s in ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
            assert!(ok(s), "{s} must be allowed");
        }
    }

    #[test]
    fn rejects_other_schemes_and_ip_targets() {
        assert!(get("file:///etc/passwd", "*/*", 10, is_html).is_err());
        assert!(get("ftp://example.com/", "*/*", 10, is_html).is_err());
        assert!(get("http://127.0.0.1:1/", "*/*", 10, is_html).is_err());
        assert!(get("http://[::1]/", "*/*", 10, is_html).is_err());
        assert!(get("http://localhost/", "*/*", 10, is_html).is_err());
        assert!(get("http://192.168.1.1/", "*/*", 10, is_html).is_err());
    }

    /// Live check against the owner's own public sites; skipped unless MIGA_LIVE_TEST=1.
    #[test]
    fn live_fetch_own_sites() {
        if std::env::var("MIGA_LIVE_TEST").ok().as_deref() != Some("1") {
            return;
        }
        for site in ["https://vniverse77.com", "https://miga.vniverse77.com"] {
            let (url, body) = get(site, "text/html", MAX_HTML, is_html).expect(site);
            let html = String::from_utf8_lossy(&body);
            println!("{site} -> {url} ({} bytes) has og:title: {}", body.len(), html.contains("og:title"));
            assert!(html.contains("<title"));
        }
    }
}

//! The window.
//!
//! It is Saale itself: a plain remote webview pointed at the instance this
//! machine is paired with, with no IPC and no local bridge. Page JavaScript can
//! therefore reach nothing of the agent — the capture and input APIs are only
//! ever reachable over the agent's own channel.
//!
//! The one thing the window does inject is the `saale_client` cookie, so a chat
//! started here is bound to this computer. Without it Saale would have no idea
//! which machine the chat came from, and a chat may only use the computer its
//! newest message came from.

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// The cookie Saale reads to bind a chat to a computer. Same name as
/// `CLIENT_DEVICE_COOKIE` in `src/lib/devices/shared.ts`.
const CLIENT_COOKIE: &str = "saale_client";

/// A `saale://pair?url=...&code=...` link, as a launcher hands it over.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PairLink {
    pub url: Option<String>,
    pub code: Option<String>,
}

impl PairLink {
    /// The link in the arguments this process was started with.
    pub fn from_args(args: impl Iterator<Item = String>) -> PairLink {
        for arg in args {
            if !arg.starts_with("saale://") {
                continue;
            }
            let query = arg
                .split_once('?')
                .map(|(_, query)| query)
                .unwrap_or_default();
            let mut link = PairLink::default();
            for pair in query.split('&') {
                let Some((key, value)) = pair.split_once('=') else {
                    continue;
                };
                let decoded = percent_decode(value);
                match key {
                    "url" => link.url = Some(decoded),
                    "code" => link.code = Some(decoded),
                    _ => {}
                }
            }
            return link;
        }
        PairLink::default()
    }
}

/// Enough of percent-decoding for a URL in a query string.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The script that claims this computer for chats started in the window.
fn cookie_script(device_id: &str) -> String {
    format!(
        "document.cookie = \"{CLIENT_COOKIE}={device_id}; path=/; max-age=31536000; samesite=lax\";"
    )
}

/**
 * Open the window.
 *
 * `url` is the instance to show, or nothing to show the local "not paired" page.
 * `device_id` is the computer Saale should bind this window's chats to.
 */
pub fn open(url: Option<String>, device_id: Option<String>) -> Result<(), String> {
    let target = match url.as_deref() {
        Some(url) => {
            let parsed = url
                .parse()
                .map_err(|err| format!("\"{url}\" is not a URL: {err}"))?;
            WebviewUrl::External(parsed)
        }
        None => WebviewUrl::App("index.html".into()),
    };

    tauri::Builder::default()
        .setup(move |app| {
            let mut window = WebviewWindowBuilder::new(app, "main", target)
                .title("Saale")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 400.0);

            if let Some(device_id) = device_id.as_deref() {
                window = window.initialization_script(cookie_script(device_id));
            }

            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|err| format!("Cannot open the window: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_pairing_link() {
        let link = PairLink::from_args(
            [
                "--flag",
                "saale://pair?url=http%3A%2F%2Fsaale.example.com&code=ABCD-EFGH",
            ]
            .into_iter()
            .map(str::to_string),
        );

        assert_eq!(link.url.as_deref(), Some("http://saale.example.com"));
        assert_eq!(link.code.as_deref(), Some("ABCD-EFGH"));
    }

    #[test]
    fn has_nothing_for_a_plain_start() {
        assert_eq!(PairLink::from_args(std::iter::empty()), PairLink::default());
    }

    #[test]
    fn claims_the_computer_for_the_window() {
        let script = cookie_script("dev-1");
        assert!(script.contains("saale_client=dev-1"));
        assert!(script.contains("path=/"));
    }
}

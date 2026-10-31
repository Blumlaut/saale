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

/// Register this app as the handler for `saale://` links.
///
/// Saale's "Open in the desktop app" button is the whole pairing step, and it
/// only works if something claims the scheme. A first run installs the desktop
/// entry for the current user, so the second click lands.
pub fn register_scheme_handler() {
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        return;
    };

    // An AppImage runs from a temporary mount; the file to launch again is the
    // AppImage itself.
    let exec = std::env::var("APPIMAGE")
        .map(std::path::PathBuf::from)
        .or_else(|_| std::env::current_exe())
        .unwrap_or_default();
    if exec.as_os_str().is_empty() {
        return;
    }

    let dir = home.join(".local/share/applications");
    let path = dir.join("saale-agent.desktop");
    let entry = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Saale Agent\n\
         Comment=Let a Saale chat use this computer\n\
         Exec=\"{}\" %u\n\
         Icon=saale-agent\n\
         Terminal=false\n\
         Categories=Utility;\n\
         MimeType=x-scheme-handler/saale;\n",
        exec.display()
    );

    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current != entry {
        if let Err(err) = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, &entry))
        {
            println!(
                "Cannot register the saale:// handler in {}: {err}",
                dir.display()
            );
            return;
        }
    }

    // Best effort: a missing xdg tool means the entry is there and the desktop
    // database catches up on its own.
    for command in [
        vec!["update-desktop-database", dir.to_string_lossy().as_ref()],
        vec![
            "xdg-mime",
            "default",
            "saale-agent.desktop",
            "x-scheme-handler/saale",
        ],
    ] {
        let (program, args) = command.split_first().expect("a program");
        match std::process::Command::new(program).args(args).output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => println!(
                "{program} said: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(err) => println!("Cannot run {program}: {err}"),
        }
    }
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

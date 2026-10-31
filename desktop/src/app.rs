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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::tools::Groups;
use crate::tray;

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

/// The file to launch again: the AppImage itself when running from one, since it
/// runs from a temporary mount.
pub fn executable() -> Option<PathBuf> {
    std::env::var("APPIMAGE")
        .map(PathBuf::from)
        .ok()
        .or_else(|| std::env::current_exe().ok())
        .filter(|path| !path.as_os_str().is_empty())
}

/// Register this app as the handler for `saale://` links.
///
/// Saale's "Open in the desktop app" button is the whole pairing step, and it
/// only works if something claims the scheme. A first run installs the desktop
/// entry for the current user, so the second click lands.
pub fn register_scheme_handler() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let Some(exec) = executable() else {
        return;
    };

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

/// What the tray needs: the switches it owns, the machine's label, and whether
/// this machine starts at login.
pub struct TrayOptions {
    pub groups: Groups,
    pub name: String,
    pub autostart: bool,
}

/**
 * Open the window.
 *
 * `url` is the instance to show, or nothing to show the local "not paired" page.
 * `device_id` is the computer Saale should bind this window's chats to. `hidden`
 * starts it in the tray, which is how a login does it.
 */
pub fn open(
    url: Option<String>,
    device_id: Option<String>,
    hidden: bool,
    tray_options: Option<TrayOptions>,
) -> Result<(), String> {
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
            let mut builder = WebviewWindowBuilder::new(app, "main", target)
                .title("Saale")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 400.0)
                .visible(!hidden);

            if let Some(device_id) = device_id.as_deref() {
                builder = builder.initialization_script(cookie_script(device_id));
            }

            let window = builder.build()?;

            // The tray is what makes closing the window safe: without it the
            // window is the only way back in.
            let tray_up = Arc::new(AtomicBool::new(false));

            match tray_options {
                Some(options) => {
                    let opener = window.clone();
                    let fallback = window.clone();
                    let up = tray_up.clone();
                    tauri::async_runtime::spawn(async move {
                        let open = Arc::new(move || {
                            let _ = opener.show();
                            let _ = opener.set_focus();
                        });
                        match tray::spawn(
                            options.groups,
                            options.name,
                            Some(open),
                            options.autostart,
                        )
                        .await
                        {
                            Ok(handle) => {
                                up.store(true, Ordering::Relaxed);
                                // Keep the icon on the bus for the life of the process.
                                std::mem::forget(handle);
                            }
                            // Nothing to reopen it with, so a login shows it.
                            Err(err) => {
                                println!("{err}. Running without a tray icon.");
                                let _ = fallback.show();
                            }
                        }
                    });
                }
                // Nothing to hide into, so a login still shows the window.
                None => {
                    let _ = window.show();
                }
            }

            let to_hide = window.clone();
            let can_hide = tray_up.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if can_hide.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = to_hide.hide();
                    }
                }
            });

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

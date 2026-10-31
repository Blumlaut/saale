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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::image::Image;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::tools::Groups;
use crate::tray;

/// The app icon, from `desktop/icons/icon.png`.
const ICON: &[u8] = include_bytes!("../icons/icon.png");

/// Side of the icon handed to an X11 taskbar, in pixels. A change-property
/// request carries the whole icon, and X11 caps a request at 256 KiB.
const TASKBAR_ICON: u32 = 128;

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
            return Self::from_query(arg.split_once('?').map(|(_, query)| query));
        }
        PairLink::default()
    }

    /// The link a page hands over, as `url` and `code`.
    pub fn from_url(url: &tauri::Url) -> PairLink {
        if url.scheme() != "saale" {
            return PairLink::default();
        }
        Self::from_query(url.query())
    }

    fn from_query(query: Option<&str>) -> PairLink {
        let mut link = PairLink::default();
        for pair in query.unwrap_or_default().split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let decoded = crate::uri::percent_decode(value);
            match key {
                "url" => link.url = Some(decoded),
                "code" => link.code = Some(decoded),
                _ => {}
            }
        }
        link
    }

    /// Nothing to do when the link names neither half.
    pub fn is_empty(&self) -> bool {
        self.url.is_none() && self.code.is_none()
    }
}

/// Set `_NET_WM_ICON` on this process's window.
///
/// GTK answers `gtk_window_set_icon` with the legacy WM_HINTS pixmap, which an
/// X11 panel ignores. The property is the one they all read, and the window
/// carrying our pid is the one to set it on.
fn publish_window_icon() {
    std::thread::spawn(|| {
        // The window is mapped a moment after it is built.
        for _ in 0..20 {
            match x11rb::connect(None) {
                Ok((conn, screen)) => {
                    if paint_icon(&conn, screen) {
                        return;
                    }
                }
                Err(err) => {
                    println!("No X11 to set the window icon on: {err}");
                    return;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });
}

/// The pixels `_NET_WM_ICON` takes: width, height, then ARGB words.
fn icon_pixels() -> Option<(u32, u32, Vec<u32>)> {
    let image = image::load_from_memory(ICON).ok()?.into_rgba8();
    let image = if image.width() > TASKBAR_ICON {
        image::imageops::resize(
            &image,
            TASKBAR_ICON,
            TASKBAR_ICON,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        image
    };

    let mut words = Vec::with_capacity((image.width() * image.height()) as usize);
    for pixel in image.pixels() {
        let [r, g, b, a] = pixel.0;
        words
            .push((u32::from(a) << 24) | (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b));
    }
    Some((image.width(), image.height(), words))
}

/// One attempt: find our window and set the property on it.
fn paint_icon(conn: &x11rb::rust_connection::RustConnection, screen: usize) -> bool {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, MapState, PropMode};
    use x11rb::wrapper::ConnectionExt as _;

    let Some((width, height, pixels)) = icon_pixels() else {
        println!("Cannot read the icon to hand to the taskbar");
        return true;
    };

    let root = conn.setup().roots[screen].root;
    let tree = match conn.query_tree(root) {
        Ok(cookie) => match cookie.reply() {
            Ok(tree) => tree,
            Err(err) => {
                println!("Cannot list X11 windows: {err}");
                return true;
            }
        },
        Err(err) => {
            println!("Cannot list X11 windows: {err}");
            return false;
        }
    };

    let pid_atom = match conn.intern_atom(false, b"_NET_WM_PID") {
        Ok(cookie) => match cookie.reply() {
            Ok(reply) => reply.atom,
            Err(err) => {
                println!("Cannot ask X11 for _NET_WM_PID: {err}");
                return true;
            }
        },
        Err(err) => {
            println!("Cannot ask X11 for _NET_WM_PID: {err}");
            return true;
        }
    };
    let icon_atom = match conn.intern_atom(false, b"_NET_WM_ICON") {
        Ok(cookie) => match cookie.reply() {
            Ok(reply) => reply.atom,
            Err(err) => {
                println!("Cannot ask X11 for _NET_WM_ICON: {err}");
                return true;
            }
        },
        Err(err) => {
            println!("Cannot ask X11 for _NET_WM_ICON: {err}");
            return true;
        }
    };

    let ours = std::process::id();
    println!(
        "looking for our toplevel, pid {ours}, {} children",
        tree.children.len()
    );
    let mut painted = false;
    let mut data = Vec::with_capacity(pixels.len() + 2);
    data.push(width);
    data.push(height);
    data.extend(pixels);

    for window in tree.children {
        let property = match conn.get_property(false, window, pid_atom, AtomEnum::CARDINAL, 0, 1) {
            Ok(cookie) => match cookie.reply() {
                Ok(property) => property,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        let pid = property
            .value32()
            .and_then(|mut values| values.next())
            .unwrap_or_default();
        if pid != ours {
            continue;
        }
        // GTK's group leader carries the same pid and class but is never shown.
        match conn.get_window_attributes(window) {
            Ok(cookie) => match cookie.reply() {
                Ok(attributes) if attributes.map_state == MapState::VIEWABLE => {}
                Ok(_) => continue,
                Err(err) => {
                    println!("Cannot read window {window:#x}: {err}");
                    continue;
                }
            },
            Err(err) => {
                println!("Cannot read window {window:#x}: {err}");
                continue;
            }
        }

        match conn.change_property32(
            PropMode::REPLACE,
            window,
            icon_atom,
            AtomEnum::CARDINAL,
            &data,
        ) {
            Ok(cookie) => match cookie.check() {
                Ok(()) => println!("Handed the taskbar its icon."),
                Err(err) => println!("X11 refused the window icon: {err}"),
            },
            Err(err) => println!("Cannot set the window icon: {err}"),
        }
        painted = true;
    }

    painted
}

/// The script that claims this computer for chats started in the window.
fn cookie_script(device_id: &str) -> String {
    format!(
        "document.cookie = \"{CLIENT_COOKIE}={device_id}; path=/; max-age=31536000; samesite=lax\";"
    )
}

/// Hand a `saale://` link to the app, from inside the window.
///
/// A page cannot launch a handler on its own, and the webview has no idea what
/// `saale:` means: left alone it replaces Saale with "The URL can't be shown".
/// So the link is taken here, the app pairs, and the window lands on the
/// instance. Returns the instance to show, or nothing when pairing failed.
pub type OnPairLink = Arc<dyn Fn(PairLink, tauri::AppHandle) -> Option<String> + Send + Sync>;

/// What the tray needs: the switches it owns, the machine's label, and whether
/// this machine starts at login.
pub struct TrayOptions {
    pub groups: Groups,
    pub name: String,
    pub autostart: bool,
}

/// Whether the tray is up, which decides what closing the window does.
#[derive(Clone)]
struct TrayUp(Arc<AtomicBool>);

/// Keep the icon on the bus and the window reachable.
fn start_tray(window: tauri::WebviewWindow, options: TrayOptions, up: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        let opener = window.clone();
        let fallback = window.clone();
        let open: tray::OpenWindow = Arc::new(move || {
            let _ = opener.show();
            let _ = opener.set_focus();
        });

        match tray::spawn(options.groups, options.name, Some(open), options.autostart).await {
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

/// Put the tray on a window that already exists, which is what a pairing from
/// inside the window needs: it started unpaired, so it started without one.
pub fn start_tray_for(app: &tauri::AppHandle, options: TrayOptions) {
    let Some(window) = app.get_webview_window("main") else {
        println!("Cannot find the window to give the tray to");
        return;
    };
    let up = app.state::<TrayUp>().0.clone();
    start_tray(window, options, up);
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
    on_link: OnPairLink,
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
            // Wayland reports this as the app id, and a taskbar looks the icon up
            // by that name. Without it GTK's capitalised class is used and the
            // lookup finds nothing.
            gtk::gdk::set_program_class("saale-agent");
            gtk::glib::set_prgname(Some("saale-agent"));

            let mut builder = WebviewWindowBuilder::new(app, "main", target)
                .title("Saale")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 400.0)
                .visible(!hidden)
                .icon(Image::from_bytes(ICON)?)?;

            if let Some(device_id) = device_id.as_deref() {
                builder = builder.initialization_script(cookie_script(device_id));
            }

            // A `saale://` link is the pairing step. The webview cannot load it,
            // and the pairing needs a network round trip, so the link is taken
            // here and the work happens off the main thread.
            let handle = app.handle().clone();
            let link_handle = handle.clone();
            builder = builder.on_navigation(move |url| {
                if url.scheme() != "saale" {
                    return true;
                }
                let link = PairLink::from_url(url);
                if link.is_empty() {
                    return false;
                }

                let on_link = on_link.clone();
                let handle = link_handle.clone();
                std::thread::spawn(move || match on_link(link, handle.clone()) {
                    Some(target) => match target.parse::<tauri::Url>() {
                        Ok(url) => {
                            if let Some(window) = handle.get_webview_window("main") {
                                if let Err(err) = window.navigate(url) {
                                    println!("Cannot open {target}: {err}");
                                }
                            }
                        }
                        Err(err) => println!("\"{target}\" is not a URL: {err}"),
                    },
                    None => println!(
                        "Pairing did not go through. Mint a new code in Saale's integrations page."
                    ),
                });

                false
            });

            let window = builder.build()?;

            // The theme copy and StartupWMClass are what a Wayland shell matches
            // a window to; an X11 panel reads the property instead.
            if let Err(err) = window.set_icon(Image::from_bytes(ICON)?) {
                println!("Cannot set the window icon: {err}");
            }
            publish_window_icon();

            // The tray is what makes closing the window safe: without it the
            // window is the only way back in.
            let tray_up = Arc::new(AtomicBool::new(false));
            app.manage(TrayUp(tray_up.clone()));

            match tray_options {
                Some(options) => start_tray(window.clone(), options, tray_up.clone()),
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

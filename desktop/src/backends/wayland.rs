//! Input on Wayland, through the RemoteDesktop portal.
//!
//! Wayland has no synthetic input of its own, so the agent asks the portal for
//! a remote desktop session and drives the pointer and keyboard over D-Bus. One
//! consent dialog covers it, and a restore token keeps it from coming back.
//!
//! Absolute pointer motion is expressed in a screen cast stream's logical space,
//! so the session also selects a monitor source. The streams are never consumed:
//! they exist for their geometry, which is what turns a point in the screenshot
//! into a pointer position.

use std::path::PathBuf;

use ashpd::desktop::{
    remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions, StartOptions},
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    PersistMode, Session,
};
use ashpd::enumflags2::BitFlags;

/// One captured monitor, as the portal describes it.
#[derive(Clone, Debug)]
pub struct StreamInfo {
    /// PipeWire node id, which is what absolute motion is relative to.
    pub node: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl StreamInfo {
    /// Whether a point in the desktop's logical space falls on this monitor.
    fn holds(&self, x: f64, y: f64) -> bool {
        x >= f64::from(self.x)
            && y >= f64::from(self.y)
            && x < f64::from(self.x + self.width)
            && y < f64::from(self.y + self.height)
    }
}

/// A live portal session.
struct Live {
    remote: RemoteDesktop,
    session: Session<RemoteDesktop>,
    streams: Vec<StreamInfo>,
}

/// The portal session, created the first time something needs it.
pub struct Wayland {
    live: tokio::sync::Mutex<Option<Live>>,
    token_path: PathBuf,
}

impl Wayland {
    pub fn new(token_path: PathBuf) -> Wayland {
        Wayland {
            live: tokio::sync::Mutex::new(None),
            token_path,
        }
    }

    /// Whether this process is on a Wayland session.
    pub fn available() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some()
    }

    /// The monitors the session shares, for mapping a click onto one.
    pub async fn streams(&self) -> Result<Vec<StreamInfo>, String> {
        let mut slot = self.live.lock().await;
        Ok(self.ensure(&mut slot).await?.streams.clone())
    }

    /// Open the session, or reuse the one that is already open.
    async fn ensure<'a>(&self, slot: &'a mut Option<Live>) -> Result<&'a Live, String> {
        if slot.is_none() {
            *slot = Some(self.open().await?);
        }
        slot.as_ref()
            .ok_or_else(|| "The portal session is not open".to_string())
    }

    /// Create, select and start the session. This is the call that asks the user.
    async fn open(&self) -> Result<Live, String> {
        let remote = RemoteDesktop::new()
            .await
            .map_err(|err| format!("No remote desktop portal: {err}"))?;
        let screencast = Screencast::new()
            .await
            .map_err(|err| format!("No screen cast portal: {err}"))?;

        let session = remote
            .create_session(Default::default())
            .await
            .map_err(|err| format!("Cannot open a portal session: {err}"))?;

        let token = self.read_token();
        remote
            .select_devices(
                &session,
                SelectDevicesOptions::default()
                    .set_devices(DeviceType::Keyboard | DeviceType::Pointer)
                    .set_persist_mode(PersistMode::ExplicitlyRevoked)
                    .set_restore_token(token.as_deref()),
            )
            .await
            .map_err(|err| format!("Cannot ask for input devices: {err}"))?;

        // The monitor list is not consumed; absolute motion is expressed in its
        // space. Persistence is managed by the remote desktop portal, so this
        // call carries no persist options of its own.
        screencast
            .select_sources(
                &session,
                SelectSourcesOptions::default()
                    .set_sources(BitFlags::from_flag(SourceType::Monitor))
                    .set_multiple(true)
                    .set_cursor_mode(CursorMode::Hidden),
            )
            .await
            .map_err(|err| format!("Cannot ask for a monitor: {err}"))?;

        let selected = remote
            .start(&session, None, StartOptions::default())
            .await
            .map_err(|err| format!("The portal session did not start: {err}"))?
            .response()
            .map_err(|err| format!("The portal refused the session: {err}"))?;

        if let Some(token) = selected.restore_token() {
            self.write_token(token);
        }

        let streams = selected
            .streams()
            .iter()
            .map(|stream| {
                let (x, y) = stream.position().unwrap_or((0, 0));
                let (width, height) = stream.size().unwrap_or((0, 0));
                StreamInfo {
                    node: stream.pipe_wire_node_id(),
                    x,
                    y,
                    width,
                    height,
                }
            })
            .filter(|stream| stream.width > 0 && stream.height > 0)
            .collect::<Vec<_>>();

        if streams.is_empty() {
            return Err(
                "The portal shared no monitor, so the pointer has no space to move in".to_string(),
            );
        }

        Ok(Live {
            remote,
            session,
            streams,
        })
    }

    /// Move the pointer to a point in one monitor's logical space.
    pub async fn move_absolute(&self, node: u32, x: f64, y: f64) -> Result<(), String> {
        let mut slot = self.live.lock().await;
        let outcome = {
            let live = self.ensure(&mut slot).await?;
            live.remote
                .notify_pointer_motion_absolute(&live.session, node, x, y, Default::default())
                .await
        };
        settle(&mut slot, outcome).map_err(|err| format!("Cannot move the pointer: {err}"))
    }

    pub async fn button(&self, button: i32, pressed: bool) -> Result<(), String> {
        let state = if pressed {
            KeyState::Pressed
        } else {
            KeyState::Released
        };
        let mut slot = self.live.lock().await;
        let outcome = {
            let live = self.ensure(&mut slot).await?;
            live.remote
                .notify_pointer_button(&live.session, button, state, Default::default())
                .await
        };
        settle(&mut slot, outcome).map_err(|err| format!("Cannot press a pointer button: {err}"))
    }

    /// Smooth scroll, in the motion units the portal expects.
    pub async fn scroll(&self, dx: f64, dy: f64) -> Result<(), String> {
        let mut slot = self.live.lock().await;
        let outcome = {
            let live = self.ensure(&mut slot).await?;
            live.remote
                .notify_pointer_axis(&live.session, dx, dy, Default::default())
                .await
        };
        settle(&mut slot, outcome).map_err(|err| format!("Cannot scroll: {err}"))
    }

    pub async fn keysym(&self, keysym: i32, pressed: bool) -> Result<(), String> {
        let state = if pressed {
            KeyState::Pressed
        } else {
            KeyState::Released
        };
        let mut slot = self.live.lock().await;
        let outcome = {
            let live = self.ensure(&mut slot).await?;
            live.remote
                .notify_keyboard_keysym(&live.session, keysym, state, Default::default())
                .await
        };
        settle(&mut slot, outcome).map_err(|err| format!("Cannot press a key: {err}"))
    }

    fn read_token(&self) -> Option<String> {
        std::fs::read_to_string(&self.token_path)
            .ok()
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
    }

    fn write_token(&self, token: &str) {
        if let Some(dir) = self.token_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(err) = std::fs::write(&self.token_path, token) {
            // A lost token costs one consent dialog, not the session.
            println!("Could not keep the portal token: {err}");
        }
    }
}

/// A failed call means the session is gone, so the next one asks for a new one
/// instead of talking to a dead object path.
fn settle(slot: &mut Option<Live>, outcome: ashpd::Result<()>) -> ashpd::Result<()> {
    if outcome.is_err() {
        *slot = None;
    }
    outcome
}

/// The evdev button codes the portal takes.
pub const BTN_LEFT: i32 = 0x110;
pub const BTN_RIGHT: i32 = 0x111;
pub const BTN_MIDDLE: i32 = 0x112;

/// The keysym for a character, as X11 numbers them.
pub fn char_keysym(character: char) -> i32 {
    let code = u32::from(character);
    // Latin-1 prints as its own keysym; everything else is offset.
    if (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code) {
        code as i32
    } else {
        0x0100_0000 + code as i32
    }
}

/// A named key, as a keysym.
pub fn named_keysym(name: &str) -> Option<i32> {
    let lower = name.trim().to_lowercase();
    let keysym = match lower.as_str() {
        "ctrl" | "control" => 0xffe3,                           // Control_L
        "shift" => 0xffe1,                                      // Shift_L
        "alt" => 0xffe9,                                        // Alt_L
        "meta" | "super" | "win" | "cmd" | "command" => 0xffeb, // Super_L
        "enter" | "return" => 0xff0d,
        "tab" => 0xff09,
        "esc" | "escape" => 0xff1b,
        "space" => 0x20,
        "backspace" => 0xff08,
        "delete" | "del" => 0xffff,
        "insert" => 0xff63,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" | "pgup" => 0xff55,
        "pagedown" | "pgdn" => 0xff56,
        "up" => 0xff52,
        "down" => 0xff54,
        "left" => 0xff51,
        "right" => 0xff53,
        "print" | "printscreen" => 0xff61,
        "pause" => 0xff13,
        "f1" => 0xffbe,
        "f2" => 0xffbf,
        "f3" => 0xffc0,
        "f4" => 0xffc1,
        "f5" => 0xffc2,
        "f6" => 0xffc3,
        "f7" => 0xffc4,
        "f8" => 0xffc5,
        "f9" => 0xffc6,
        "f10" => 0xffc7,
        "f11" => 0xffc8,
        "f12" => 0xffc9,
        single if single.chars().count() == 1 => char_keysym(single.chars().next()?),
        _ => return None,
    };
    Some(keysym)
}

/// Turn a point in the desktop's logical space into a monitor and a point in
/// that monitor's own space, which is what absolute motion takes.
pub fn map_to_stream(streams: &[StreamInfo], x: f64, y: f64) -> Option<(u32, f64, f64)> {
    let stream = streams
        .iter()
        .find(|stream| stream.holds(x, y))
        .or_else(|| streams.first())?;

    Some((
        stream.node,
        x - f64::from(stream.x),
        y - f64::from(stream.y),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(node: u32, x: i32, y: i32, width: i32, height: i32) -> StreamInfo {
        StreamInfo {
            node,
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn maps_a_point_onto_the_monitor_it_falls_on() {
        let streams = vec![
            display(7, 0, 0, 1920, 1080),
            display(9, 1920, 0, 1280, 1024),
        ];

        assert_eq!(
            map_to_stream(&streams, 100.0, 200.0),
            Some((7, 100.0, 200.0))
        );
        assert_eq!(
            map_to_stream(&streams, 2000.0, 100.0),
            Some((9, 80.0, 100.0))
        );
    }

    #[test]
    fn falls_back_to_the_first_monitor_outside_the_layout() {
        let streams = vec![display(7, 0, 0, 800, 600)];
        assert_eq!(
            map_to_stream(&streams, 900.0, 900.0),
            Some((7, 900.0, 900.0))
        );
    }

    #[test]
    fn has_no_target_without_a_monitor() {
        assert_eq!(map_to_stream(&[], 10.0, 10.0), None);
    }

    #[test]
    fn numbers_characters_the_way_x11_does() {
        assert_eq!(char_keysym('a'), 0x61);
        assert_eq!(char_keysym(' '), 0x20);
        assert_eq!(char_keysym('é'), 0xe9);
        assert_eq!(char_keysym('→'), 0x0100_2192);
    }

    #[test]
    fn knows_the_keys_a_person_writes() {
        assert_eq!(named_keysym("ctrl"), Some(0xffe3));
        assert_eq!(named_keysym("Enter"), Some(0xff0d));
        assert_eq!(named_keysym("f5"), Some(0xffc2));
        assert_eq!(named_keysym("q"), Some(0x71));
        assert_eq!(named_keysym("nonsense"), None);
    }
}

//! The machine's screen and pointer.
//!
//! Capture goes through `xcap`, which reads the X server on X11 and the
//! Screenshot portal on Wayland. Input is two paths: `enigo` over X11, and the
//! RemoteDesktop portal on Wayland, where the compositor allows nothing else.
//!
//! Coordinates are the delicate part. The model sees a downscaled image, so a
//! click arrives in image space and has to be mapped back to the display's
//! position on the desktop, and on Wayland from there into a monitor's own
//! logical space. Every capture records the display and the factor it was
//! scaled by, and a click maps through the capture of the same display.

mod wayland;

use std::collections::HashMap;
use std::sync::Mutex;

use enigo::{
    Axis, Button as X11Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
};
use image::{imageops, RgbImage};

use wayland::{char_keysym, map_to_stream, named_keysym, Wayland, BTN_LEFT, BTN_MIDDLE, BTN_RIGHT};

/// Longest edge of the image handed to the model.
const MAX_IMAGE_EDGE: u32 = 1568;

/// How long a capture gets before the tool call gives up on it. A portal
/// selector waits for a person, so this is generous; it exists so a portal that
/// never answers cannot leave a chat waiting for good.
const CAPTURE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(120);

/// How much one scroll step moves, in the portal's motion units.
const SCROLL_UNIT: f64 = 15.0;

/// A pointer button, in the terms the tools speak.
#[derive(Clone, Copy, Debug)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// A display, as the compositor lays it out.
#[derive(Clone, Debug)]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    /// Top-left corner in the desktop's coordinate space.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

/// One capture, and the space its image coordinates live in.
#[derive(Clone, Debug)]
struct CaptureSpace {
    display: DisplayInfo,
    image_width: u32,
    image_height: u32,
}

/// What a capture returns.
pub struct Shot {
    pub png: Vec<u8>,
    pub display: DisplayInfo,
    pub image_width: u32,
    pub image_height: u32,
}

/// Capture a display by asking the portal, and keep the monitor's part of it.
fn capture_with_portal(
    display: &DisplayInfo,
    displays: &[DisplayInfo],
) -> Result<image::RgbaImage, String> {
    // A backend that will not grab the screen on its own still answers a request
    // for a selection, which is the selector the user sees.
    let png = with_deadline(wayland::screenshot(false), CAPTURE_DEADLINE).or_else(|err| {
        println!("The portal would not take a picture on its own ({err}); asking for one.");
        with_deadline(wayland::screenshot(true), CAPTURE_DEADLINE)
    })?;
    let desktop = image::load_from_memory(&png)
        .map_err(|err| format!("The portal sent something that is not an image: {err}"))?
        .to_rgba8();

    Ok(crop_to(desktop, display, displays))
}

/// The monitor's rectangle inside a capture of the whole desktop.
fn crop_to(
    image: image::RgbaImage,
    display: &DisplayInfo,
    displays: &[DisplayInfo],
) -> image::RgbaImage {
    if display.width == 0 || display.height == 0 {
        return image;
    }

    // The portal hands back physical pixels; the layout is logical, and the
    // capture covers the whole layout.
    let layout_width = displays
        .iter()
        .map(|other| other.x.max(0) as u32 + other.width)
        .max()
        .unwrap_or(display.width);
    let scale = f64::from(image.width()) / f64::from(layout_width.max(1));
    let x = (f64::from(display.x) * scale).round().max(0.0) as u32;
    let y = (f64::from(display.y) * scale).round().max(0.0) as u32;
    let width = ((f64::from(display.width) * scale).round() as u32)
        .min(image.width() - x.min(image.width()));
    let height = ((f64::from(display.height) * scale).round() as u32)
        .min(image.height() - y.min(image.height()));

    if width == 0 || height == 0 {
        return image;
    }
    if x == 0 && y == 0 && width == image.width() && height == image.height() {
        return image;
    }

    imageops::crop_imm(&image, x, y, width, height).to_image()
}

/// Capture a display through xcap, which reads the X server.
fn capture_with_xcap(display: &DisplayInfo) -> Result<image::RgbaImage, String> {
    let handle = xcap::Monitor::all()
        .map_err(|err| format!("Cannot list displays: {err}"))?
        .into_iter()
        .find(|candidate| {
            candidate
                .id()
                .map(|id| format!("display-{id}") == display.id)
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("{} went away", display.id))?;

    let id = display.id.clone();
    with_deadline(
        async move {
            handle
                .capture_image()
                .map_err(|err| format!("Cannot capture {id}: {err}"))
        },
        CAPTURE_DEADLINE,
    )
}

/// Run something that talks to the portal on a thread of its own, and stop
/// waiting for it after a while.
///
/// The portal can be slow because a person is looking at a dialog, or because
/// nothing is listening at all; neither may hold a tool call open forever.
fn with_deadline<T: Send + 'static>(
    work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
    deadline: std::time::Duration,
) -> Result<T, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(err) => {
                let _ = sender.send(Err(format!("Cannot start the portal client: {err}")));
                return;
            }
        };
        let _ = sender.send(runtime.block_on(work));
    });

    receiver.recv_timeout(deadline).map_err(|_| {
        format!(
            "The screen did not answer within {} seconds.",
            deadline.as_secs()
        )
    })?
}

/// A window on the desktop.
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub focused: bool,
}

/// How this session takes input.
enum Input {
    /// X11, through enigo.
    X11(Box<Mutex<Option<Enigo>>>),
    /// Wayland, through the RemoteDesktop portal.
    Wayland(Wayland),
}

/// The display server this process can drive.
pub struct Desktop {
    /// Whether there is a display to drive. Decided once, at startup.
    available: bool,
    input: Input,
    /// The capture each display's coordinates are currently relative to.
    spaces: Mutex<HashMap<String, CaptureSpace>>,
}

impl Desktop {
    pub fn new() -> Desktop {
        let available = wayland::Wayland::available() || std::env::var_os("DISPLAY").is_some();

        let input = if wayland::Wayland::available() {
            let token = crate::config::config_path().with_file_name("portal-token");
            Input::Wayland(Wayland::new(token))
        } else {
            Input::X11(Box::new(Mutex::new(None)))
        };

        Desktop {
            available,
            input,
            spaces: Mutex::new(HashMap::new()),
        }
    }

    /// Whether this process has a display it can drive at all.
    pub fn available(&self) -> bool {
        self.available
    }

    fn displays() -> Result<Vec<DisplayInfo>, String> {
        let monitors =
            xcap::Monitor::all().map_err(|err| format!("Cannot list displays: {err}"))?;
        if monitors.is_empty() {
            return Err("This machine reported no display.".to_string());
        }

        monitors
            .into_iter()
            .map(|monitor| {
                let id = monitor.id().map_err(|err| err.to_string())?;
                Ok(DisplayInfo {
                    id: format!("display-{id}"),
                    name: monitor.name().unwrap_or_default(),
                    x: monitor.x().map_err(|err| err.to_string())?,
                    y: monitor.y().map_err(|err| err.to_string())?,
                    width: monitor.width().map_err(|err| err.to_string())?,
                    height: monitor.height().map_err(|err| err.to_string())?,
                    scale: f64::from(monitor.scale_factor().unwrap_or(1.0)),
                    primary: monitor.is_primary().unwrap_or(false),
                })
            })
            .collect()
    }

    fn monitor(monitors: &[DisplayInfo], wanted: Option<&str>) -> Result<DisplayInfo, String> {
        if let Some(wanted) = wanted {
            let found = monitors
                .iter()
                .find(|display| display.id == wanted || display.name == wanted);
            if let Some(display) = found {
                return Ok(display.clone());
            }
            return Err(format!(
                "No display called \"{wanted}\". This machine has {}.",
                monitors
                    .iter()
                    .map(|display| display.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }

        Ok(monitors
            .iter()
            .find(|display| display.primary)
            .unwrap_or(&monitors[0])
            .clone())
    }

    /// Capture a display and remember the space its image lives in.
    pub fn capture(&self, monitor: Option<&str>) -> Result<Shot, String> {
        let displays = Self::displays()?;
        let display = Self::monitor(&displays, monitor)?;

        let image = match &self.input {
            Input::Wayland(_) => capture_with_portal(&display, &displays)?,
            Input::X11(_) => capture_with_xcap(&display)?,
        };

        let scaled = downscale(&image::DynamicImage::ImageRgba8(image).to_rgb8());

        let mut png = Vec::new();
        scaled
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|err| format!("Cannot encode the capture: {err}"))?;

        let space = CaptureSpace {
            display: display.clone(),
            image_width: scaled.width(),
            image_height: scaled.height(),
        };
        self.spaces
            .lock()
            .map_err(|err| format!("The capture store is poisoned: {err}"))?
            .insert(display.id.clone(), space);

        Ok(Shot {
            png,
            display,
            image_width: scaled.width(),
            image_height: scaled.height(),
        })
    }

    /// The space a point is expressed in: the last capture of that display, or a
    /// fresh one when the model clicks without having looked.
    fn space(&self, monitor: Option<&str>) -> Result<CaptureSpace, String> {
        let displays = Self::displays()?;
        let display = Self::monitor(&displays, monitor)?;

        let known = self
            .spaces
            .lock()
            .map_err(|err| format!("The capture store is poisoned: {err}"))?
            .get(&display.id)
            .cloned();

        match known {
            Some(space) => Ok(space),
            None => {
                self.capture(Some(&display.id))?;
                let spaces = self
                    .spaces
                    .lock()
                    .map_err(|err| format!("The capture store is poisoned: {err}"))?;
                spaces
                    .get(&display.id)
                    .cloned()
                    .ok_or_else(|| format!("Cannot capture {}", display.id))
            }
        }
    }

    /// Map a point in a capture's image space onto the desktop.
    fn screen_point(&self, monitor: Option<&str>, x: f64, y: f64) -> Result<(f64, f64), String> {
        let space = self.space(monitor)?;
        if x < 0.0
            || y < 0.0
            || x >= f64::from(space.image_width)
            || y >= f64::from(space.image_height)
        {
            return Err(format!(
                "({x}, {y}) is outside the {} image, which is {} by {}.",
                space.display.id, space.image_width, space.image_height
            ));
        }

        let factor_x = f64::from(space.display.width) / f64::from(space.image_width);
        let factor_y = f64::from(space.display.height) / f64::from(space.image_height);

        Ok((
            f64::from(space.display.x) + x * factor_x,
            f64::from(space.display.y) + y * factor_y,
        ))
    }

    /// The monitor and point absolute motion takes on Wayland.
    async fn wayland_target(
        &self,
        input: &Wayland,
        monitor: Option<&str>,
        x: f64,
        y: f64,
    ) -> Result<(u32, f64, f64), String> {
        let (screen_x, screen_y) = self.screen_point(monitor, x, y)?;
        let streams = input.streams().await?;
        map_to_stream(&streams, screen_x, screen_y)
            .ok_or_else(|| "The portal shared no monitor to point at".to_string())
    }

    fn with_enigo<T>(&self, run: impl FnOnce(&mut Enigo) -> T) -> Result<T, String> {
        let Input::X11(slot) = &self.input else {
            return Err("This session takes input through the portal".to_string());
        };

        let mut guard = slot
            .lock()
            .map_err(|err| format!("The input device is poisoned: {err}"))?;

        if guard.is_none() {
            // enigo's libei backend unwraps its D-Bus connection, so a machine
            // without a session bus panics instead of failing. A panic here must
            // cost the pointer, not the agent.
            let opened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                Enigo::new(&Settings::default())
            }))
            .map_err(|_| "Cannot open the input device: no D-Bus session bus".to_string())?;

            *guard = Some(opened.map_err(|err| format!("Cannot open the input device: {err}"))?);
        }

        let enigo = guard.as_mut().ok_or("The input device is not available")?;
        Ok(run(enigo))
    }

    pub async fn click(
        &self,
        monitor: Option<&str>,
        x: f64,
        y: f64,
        button: Button,
        times: u32,
    ) -> Result<(), String> {
        let times = times.max(1);

        match &self.input {
            Input::X11(_) => {
                let (screen_x, screen_y) = self.screen_point(monitor, x, y)?;
                self.with_enigo(|enigo| {
                    enigo
                        .move_mouse(screen_x as i32, screen_y as i32, Coordinate::Abs)
                        .map_err(|err| format!("Cannot move the pointer: {err}"))?;
                    for _ in 0..times {
                        enigo
                            .button(x11_button(button), Direction::Click)
                            .map_err(|err| format!("Cannot click: {err}"))?;
                    }
                    Ok(())
                })?
            }
            Input::Wayland(input) => {
                let (node, screen_x, screen_y) = self.wayland_target(input, monitor, x, y).await?;
                input.move_absolute(node, screen_x, screen_y).await?;
                for _ in 0..times {
                    input.button(evdev_button(button), true).await?;
                    input.button(evdev_button(button), false).await?;
                }
                Ok(())
            }
        }
    }

    pub async fn move_to(&self, monitor: Option<&str>, x: f64, y: f64) -> Result<(), String> {
        match &self.input {
            Input::X11(_) => {
                let (screen_x, screen_y) = self.screen_point(monitor, x, y)?;
                self.with_enigo(|enigo| {
                    enigo
                        .move_mouse(screen_x as i32, screen_y as i32, Coordinate::Abs)
                        .map_err(|err| format!("Cannot move the pointer: {err}"))
                })?
            }
            Input::Wayland(input) => {
                let (node, screen_x, screen_y) = self.wayland_target(input, monitor, x, y).await?;
                input.move_absolute(node, screen_x, screen_y).await
            }
        }
    }

    pub async fn drag(
        &self,
        monitor: Option<&str>,
        from: (f64, f64),
        to: (f64, f64),
    ) -> Result<(), String> {
        // A straight jump reads as a drop, not a drag, in most toolkits.
        const STEPS: u32 = 12;

        match &self.input {
            Input::X11(_) => {
                let start = self.screen_point(monitor, from.0, from.1)?;
                let end = self.screen_point(monitor, to.0, to.1)?;

                self.with_enigo(|enigo| {
                    enigo
                        .move_mouse(start.0 as i32, start.1 as i32, Coordinate::Abs)
                        .map_err(|err| format!("Cannot move the pointer: {err}"))?;
                    enigo
                        .button(X11Button::Left, Direction::Press)
                        .map_err(|err| format!("Cannot hold the button: {err}"))?;

                    for step in 1..=STEPS {
                        let x = start.0 + (end.0 - start.0) * f64::from(step) / f64::from(STEPS);
                        let y = start.1 + (end.1 - start.1) * f64::from(step) / f64::from(STEPS);
                        enigo
                            .move_mouse(x as i32, y as i32, Coordinate::Abs)
                            .map_err(|err| format!("Cannot move the pointer: {err}"))?;
                        std::thread::sleep(std::time::Duration::from_millis(12));
                    }

                    enigo
                        .button(X11Button::Left, Direction::Release)
                        .map_err(|err| format!("Cannot release the button: {err}"))
                })?
            }
            Input::Wayland(input) => {
                let start = self.wayland_target(input, monitor, from.0, from.1).await?;
                let end = self.wayland_target(input, monitor, to.0, to.1).await?;

                input.move_absolute(start.0, start.1, start.2).await?;
                input.button(BTN_LEFT, true).await?;

                if start.0 == end.0 {
                    for step in 1..=STEPS {
                        let ratio = f64::from(step) / f64::from(STEPS);
                        input
                            .move_absolute(
                                start.0,
                                start.1 + (end.1 - start.1) * ratio,
                                start.2 + (end.2 - start.2) * ratio,
                            )
                            .await?;
                        tokio::time::sleep(std::time::Duration::from_millis(12)).await;
                    }
                } else {
                    // Two monitors: the move has to land on the second one.
                    input.move_absolute(end.0, end.1, end.2).await?;
                }

                input.button(BTN_LEFT, false).await
            }
        }
    }

    pub async fn scroll(
        &self,
        monitor: Option<&str>,
        x: f64,
        y: f64,
        dy: i32,
        dx: i32,
    ) -> Result<(), String> {
        match &self.input {
            Input::X11(_) => {
                let (screen_x, screen_y) = self.screen_point(monitor, x, y)?;
                self.with_enigo(|enigo| {
                    enigo
                        .move_mouse(screen_x as i32, screen_y as i32, Coordinate::Abs)
                        .map_err(|err| format!("Cannot move the pointer: {err}"))?;
                    if dy != 0 {
                        enigo
                            .scroll(dy, Axis::Vertical)
                            .map_err(|err| format!("Cannot scroll: {err}"))?;
                    }
                    if dx != 0 {
                        enigo
                            .scroll(dx, Axis::Horizontal)
                            .map_err(|err| format!("Cannot scroll: {err}"))?;
                    }
                    Ok(())
                })?
            }
            Input::Wayland(input) => {
                let (node, screen_x, screen_y) = self.wayland_target(input, monitor, x, y).await?;
                input.move_absolute(node, screen_x, screen_y).await?;
                input
                    .scroll(f64::from(dx) * SCROLL_UNIT, f64::from(dy) * SCROLL_UNIT)
                    .await
            }
        }
    }

    pub async fn type_text(&self, text: &str) -> Result<(), String> {
        match &self.input {
            Input::X11(_) => self.with_enigo(|enigo| {
                enigo
                    .text(text)
                    .map_err(|err| format!("Cannot type: {err}"))
            })?,
            Input::Wayland(input) => {
                for character in text.chars() {
                    let keysym = char_keysym(character);
                    input.keysym(keysym, true).await?;
                    input.keysym(keysym, false).await?;
                }
                Ok(())
            }
        }
    }

    /// Press a key or a combination, written `ctrl+shift+t`.
    pub async fn press_key(&self, combination: &str) -> Result<(), String> {
        let parts: Vec<&str> = combination
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        let (last, modifiers) = parts
            .split_last()
            .ok_or_else(|| "A key is required".to_string())?;

        match &self.input {
            Input::X11(_) => {
                let key = x11_key(last)?;
                let held: Vec<Key> = modifiers
                    .iter()
                    .map(|name| x11_key(name))
                    .collect::<Result<_, _>>()?;

                self.with_enigo(|enigo| {
                    for modifier in &held {
                        enigo
                            .key(*modifier, Direction::Press)
                            .map_err(|err| format!("Cannot hold a modifier: {err}"))?;
                    }
                    let pressed = enigo
                        .key(key, Direction::Click)
                        .map_err(|err| format!("Cannot press {combination}: {err}"));
                    for modifier in held.iter().rev() {
                        enigo
                            .key(*modifier, Direction::Release)
                            .map_err(|err| format!("Cannot release a modifier: {err}"))?;
                    }
                    pressed
                })?
            }
            Input::Wayland(input) => {
                let key = named_keysym(last)
                    .ok_or_else(|| format!("\"{last}\" is not a key this agent knows"))?;
                let held: Vec<i32> = modifiers
                    .iter()
                    .map(|name| {
                        named_keysym(name)
                            .ok_or_else(|| format!("\"{name}\" is not a key this agent knows"))
                    })
                    .collect::<Result<_, _>>()?;

                for modifier in &held {
                    input.keysym(*modifier, true).await?;
                }
                let pressed = input.keysym(key, true).await;
                let released = input.keysym(key, false).await;
                for modifier in held.iter().rev() {
                    input.keysym(*modifier, false).await?;
                }
                pressed.and(released)
            }
        }
    }

    pub fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        let windows = xcap::Window::all().map_err(|err| format!("Cannot list windows: {err}"))?;
        Ok(windows
            .into_iter()
            .filter(|window| !window.is_minimized().unwrap_or(false))
            .map(|window| WindowInfo {
                id: window.id().unwrap_or(0),
                title: window.title().unwrap_or_default(),
                app: window.app_name().unwrap_or_default(),
                x: window.x().unwrap_or(0),
                y: window.y().unwrap_or(0),
                width: window.width().unwrap_or(0),
                height: window.height().unwrap_or(0),
                focused: window.is_focused().unwrap_or(false),
            })
            .filter(|window| !window.title.is_empty() || !window.app.is_empty())
            .collect())
    }
}

fn x11_button(button: Button) -> X11Button {
    match button {
        Button::Left => X11Button::Left,
        Button::Right => X11Button::Right,
        Button::Middle => X11Button::Middle,
    }
}

fn evdev_button(button: Button) -> i32 {
    match button {
        Button::Left => BTN_LEFT,
        Button::Right => BTN_RIGHT,
        Button::Middle => BTN_MIDDLE,
    }
}

/// Fit the capture into the model's image budget.
fn downscale(image: &RgbImage) -> RgbImage {
    let (width, height) = image.dimensions();
    let longest = width.max(height);
    if longest <= MAX_IMAGE_EDGE {
        return image.clone();
    }

    let factor = f64::from(MAX_IMAGE_EDGE) / f64::from(longest);
    let target_w = ((f64::from(width) * factor).round() as u32).max(1);
    let target_h = ((f64::from(height) * factor).round() as u32).max(1);
    imageops::resize(image, target_w, target_h, imageops::FilterType::Triangle)
}

/// A key by the name a person writes, for the X11 path.
fn x11_key(name: &str) -> Result<Key, String> {
    let lower = name.trim().to_lowercase();
    let key = match lower.as_str() {
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" => Key::Alt,
        "meta" | "super" | "win" | "cmd" | "command" => Key::Meta,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "insert" => Key::Insert,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "pgup" => Key::PageUp,
        "pagedown" | "pgdn" => Key::PageDown,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "print" | "printscreen" => Key::PrintScr,
        "pause" => Key::Pause,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        single if single.chars().count() == 1 => Key::Unicode(single.chars().next().unwrap()),
        other => return Err(format!("\"{other}\" is not a key this agent knows")),
    };
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_combination() {
        assert_eq!(x11_key("ctrl").unwrap(), Key::Control);
        assert_eq!(x11_key("F5").unwrap(), Key::F5);
        assert_eq!(x11_key("t").unwrap(), Key::Unicode('t'));
        assert!(x11_key("nope").is_err());
    }

    #[test]
    fn keeps_a_small_capture_as_it_is() {
        let image = RgbImage::new(800, 600);
        let scaled = downscale(&image);
        assert_eq!(scaled.dimensions(), (800, 600));
    }

    #[test]
    fn fits_a_large_capture_into_the_budget() {
        let image = RgbImage::new(3840, 2160);
        let scaled = downscale(&image);
        assert_eq!(scaled.width(), MAX_IMAGE_EDGE);
        assert_eq!(scaled.height(), 882);
    }

    fn monitor(x: i32, width: u32) -> DisplayInfo {
        DisplayInfo {
            id: format!("display-{x}"),
            name: "DP-1".to_string(),
            x,
            y: 0,
            width,
            height: 1080,
            scale: 1.0,
            primary: x == 0,
        }
    }

    #[test]
    fn gives_up_on_a_screen_that_never_answers() {
        let result = with_deadline(
            std::future::pending::<Result<(), String>>(),
            std::time::Duration::from_millis(50),
        );

        assert!(result.unwrap_err().contains("did not answer"));
    }

    #[test]
    fn takes_one_monitor_out_of_a_whole_desktop_capture() {
        let monitors = [monitor(0, 1920), monitor(1920, 1920)];
        let desktop = image::RgbaImage::new(3840, 1080);
        let right = crop_to(desktop, &monitors[1], &monitors);

        assert_eq!(right.dimensions(), (1920, 1080));
    }

    #[test]
    fn keeps_a_capture_that_is_already_one_monitor() {
        let monitors = [monitor(0, 1920)];
        let shot = image::RgbaImage::new(1920, 1080);
        let cropped = crop_to(shot, &monitors[0], &monitors);

        assert_eq!(cropped.dimensions(), (1920, 1080));
    }

    #[test]
    fn reads_the_scale_the_portal_sent() {
        // a 2x display, so the capture is twice the layout
        let monitors = [monitor(0, 1920)];
        let desktop = image::RgbaImage::new(3840, 2160);
        let cropped = crop_to(desktop, &monitors[0], &monitors);

        assert_eq!(cropped.dimensions(), (3840, 2160));
    }
}

//! The machine's screen and pointer.
//!
//! One backend for now: X11, through `xcap` for capture and `enigo` for input.
//! The Wayland portal backend lands next and takes its place behind the same
//! surface.
//!
//! Coordinates are the delicate part. The model sees a downscaled image, so a
//! click arrives in image space and has to be mapped back to the display's
//! position on the desktop. Every capture records the display and the factor it
//! was scaled by, and a click maps through the capture of the same display.

use std::collections::HashMap;
use std::sync::Mutex;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use image::{imageops, RgbImage};

/// Longest edge of the image handed to the model.
const MAX_IMAGE_EDGE: u32 = 1568;

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

/// The display server this process can drive.
pub struct Desktop {
    /// Whether there is a display to drive. Decided once, at startup.
    available: bool,
    /// Created on first use: a process without a display must still start.
    enigo: Mutex<Option<Enigo>>,
    /// The capture each display's coordinates are currently relative to.
    spaces: Mutex<HashMap<String, CaptureSpace>>,
}

impl Desktop {
    pub fn new() -> Desktop {
        Desktop {
            available: std::env::var_os("DISPLAY").is_some(),
            enigo: Mutex::new(None),
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

        let image = handle
            .capture_image()
            .map_err(|err| format!("Cannot capture {}: {err}", display.id))?;

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
    fn screen_point(&self, monitor: Option<&str>, x: f64, y: f64) -> Result<(i32, i32), String> {
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
            space.display.x + (x * factor_x).round() as i32,
            space.display.y + (y * factor_y).round() as i32,
        ))
    }

    fn with_enigo<T>(&self, run: impl FnOnce(&mut Enigo) -> T) -> Result<T, String> {
        let mut guard = self
            .enigo
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

    pub fn click(
        &self,
        monitor: Option<&str>,
        x: f64,
        y: f64,
        button: Button,
        times: u32,
    ) -> Result<(), String> {
        let (screen_x, screen_y) = self.screen_point(monitor, x, y)?;
        self.with_enigo(|enigo| {
            enigo
                .move_mouse(screen_x, screen_y, Coordinate::Abs)
                .map_err(|err| format!("Cannot move the pointer: {err}"))?;
            for _ in 0..times.max(1) {
                enigo
                    .button(button, Direction::Click)
                    .map_err(|err| format!("Cannot click: {err}"))?;
            }
            Ok(())
        })?
    }

    pub fn move_to(&self, monitor: Option<&str>, x: f64, y: f64) -> Result<(), String> {
        let (screen_x, screen_y) = self.screen_point(monitor, x, y)?;
        self.with_enigo(|enigo| {
            enigo
                .move_mouse(screen_x, screen_y, Coordinate::Abs)
                .map_err(|err| format!("Cannot move the pointer: {err}"))
        })?
    }

    pub fn drag(
        &self,
        monitor: Option<&str>,
        from: (f64, f64),
        to: (f64, f64),
    ) -> Result<(), String> {
        let start = self.screen_point(monitor, from.0, from.1)?;
        let end = self.screen_point(monitor, to.0, to.1)?;

        self.with_enigo(|enigo| {
            enigo
                .move_mouse(start.0, start.1, Coordinate::Abs)
                .map_err(|err| format!("Cannot move the pointer: {err}"))?;
            enigo
                .button(Button::Left, Direction::Press)
                .map_err(|err| format!("Cannot hold the button: {err}"))?;

            // A straight jump reads as a drop, not a drag, in most toolkits.
            let steps = 12;
            for step in 1..=steps {
                let x = start.0 + (end.0 - start.0) * step / steps;
                let y = start.1 + (end.1 - start.1) * step / steps;
                enigo
                    .move_mouse(x, y, Coordinate::Abs)
                    .map_err(|err| format!("Cannot move the pointer: {err}"))?;
                std::thread::sleep(std::time::Duration::from_millis(12));
            }

            enigo
                .button(Button::Left, Direction::Release)
                .map_err(|err| format!("Cannot release the button: {err}"))
        })?
    }

    pub fn scroll(
        &self,
        monitor: Option<&str>,
        x: f64,
        y: f64,
        dy: i32,
        dx: i32,
    ) -> Result<(), String> {
        let (screen_x, screen_y) = self.screen_point(monitor, x, y)?;
        self.with_enigo(|enigo| {
            enigo
                .move_mouse(screen_x, screen_y, Coordinate::Abs)
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

    pub fn type_text(&self, text: &str) -> Result<(), String> {
        self.with_enigo(|enigo| {
            enigo
                .text(text)
                .map_err(|err| format!("Cannot type: {err}"))
        })?
    }

    /// Press a key or a combination, written `ctrl+shift+t`.
    pub fn press_key(&self, combination: &str) -> Result<(), String> {
        let parts: Vec<&str> = combination
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        let (last, modifiers) = parts
            .split_last()
            .ok_or_else(|| "A key is required".to_string())?;

        let key = key_for(last)?;
        let held: Vec<Key> = modifiers
            .iter()
            .map(|name| key_for(name))
            .collect::<Result<_, _>>()?;

        self.with_enigo(|enigo| {
            for modifier in &held {
                enigo
                    .key(*modifier, Direction::Press)
                    .map_err(|err| format!("Cannot hold {}: {err}", modifier_name(modifier)))?;
            }
            let pressed = enigo
                .key(key, Direction::Click)
                .map_err(|err| format!("Cannot press {combination}: {err}"));
            for modifier in held.iter().rev() {
                enigo
                    .key(*modifier, Direction::Release)
                    .map_err(|err| format!("Cannot release {}: {err}", modifier_name(modifier)))?;
            }
            pressed
        })?
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

fn modifier_name(key: &Key) -> &'static str {
    match key {
        Key::Control => "ctrl",
        Key::Shift => "shift",
        Key::Alt => "alt",
        Key::Meta => "meta",
        _ => "the modifier",
    }
}

/// A key by the name a person writes.
fn key_for(name: &str) -> Result<Key, String> {
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
        assert_eq!(key_for("ctrl").unwrap(), Key::Control);
        assert_eq!(key_for("F5").unwrap(), Key::F5);
        assert_eq!(key_for("t").unwrap(), Key::Unicode('t'));
        assert!(key_for("nope").is_err());
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
}

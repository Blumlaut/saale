//! Screen capture.
//!
//! Wayland needs the ScreenCast portal and PipeWire, X11 needs the X server;
//! neither backend is in this build yet. What is here is the contract the rest
//! of the feature is built against: an image plus the metadata a click needs to
//! turn a pixel into a pointer position.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use super::png;
use super::{Content, ToolResult};

const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;

pub fn screenshot_spec() -> super::ToolSpec {
    super::ToolSpec {
        name: "screenshot",
        description:
            "Capture the display. Returns the image plus the monitor's id, its origin and size in \
             the coordinate space a click uses, and the factors between the image and that space.",
        schema: json!({
            "type": "object",
            "properties": {
                "monitor": {
                    "type": "string",
                    "description": "Monitor id from a previous capture. The primary display when omitted."
                }
            }
        }),
    }
}

pub async fn screenshot(args: &Value) -> Result<ToolResult, String> {
    let monitor = args
        .get("monitor")
        .and_then(Value::as_str)
        .unwrap_or("display-1");

    let pixels = placeholder_pixels(WIDTH, HEIGHT);
    let encoded = STANDARD.encode(png::encode_rgb(WIDTH, HEIGHT, &pixels));

    // The metadata a click maps through. A real capture fills the same fields
    // from the compositor's output layout.
    let metadata = json!({
        "capture": "placeholder",
        "monitor": monitor,
        "origin": { "x": 0, "y": 0 },
        "size": { "width": WIDTH, "height": HEIGHT },
        "scale": 1.0,
        "image": { "width": WIDTH, "height": HEIGHT, "scale": 1.0 },
    });

    Ok(ToolResult {
        content: vec![
            Content::Image {
                mime: "image/png".to_string(),
                base64: encoded,
            },
            Content::Text(metadata.to_string()),
        ],
        is_error: false,
    })
}

/// A grid, so the image is visibly an image and its edges are findable.
fn placeholder_pixels(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            let cell = ((x / 40) + (y / 40)) % 2 == 0;
            let base: u8 = if cell { 32 } else { 48 };
            let edge = x < 2 || y < 2 || x + 2 >= width || y + 2 >= height;
            if edge {
                pixels.extend_from_slice(&[214, 108, 39]);
            } else {
                pixels.extend_from_slice(&[base, base, base + 8]);
            }
        }
    }
    pixels
}

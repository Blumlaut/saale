//! Files on this machine.
//!
//! Reads and writes are ordinary filesystem access as the user running the
//! agent. Nothing is sandboxed, which is why the group is a switch the user
//! owns and why every answer is bounded: a chat should not pull a 2 GB log into
//! its transcript.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::{Content, ToolResult, ToolSpec};

/// How much of a text file one read returns.
const MAX_READ_BYTES: usize = 200 * 1024;
/// An image travels whole, so it gets its own ceiling.
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// Enough of a header to recognise the formats an image can be.
const SNIFF_BYTES: usize = 4100;
/// Files a walk looks at before it gives up.
const MAX_WALK_ENTRIES: usize = 20_000;
/// Lines one grep returns.
const MAX_GREP_MATCHES: usize = 200;

pub fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "read_file",
            description: "Read a text file from this computer.",
            schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Absolute path, or one starting with ~" } },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "write_file",
            description: "Write a text file on this computer, creating parent directories.",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }),
        },
        ToolSpec {
            name: "list_dir",
            description: "List the entries of a directory on this computer.",
            schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "grep",
            description: "Find a string in the text files under a directory.",
            schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string", "description": "Directory to search. The home directory when omitted." },
                    "ignore_case": { "type": "boolean" }
                },
                "required": ["pattern"]
            }),
        },
        ToolSpec {
            name: "find",
            description: "Find files by name under a directory.",
            schema: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string" }
                },
                "required": ["pattern"]
            }),
        },
    ]
}

/// Resolve `~` and relative paths against the home directory.
fn resolve(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("A path is required".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return Ok(home().join(rest));
    }
    if trimmed == "~" {
        return Ok(home());
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        return Ok(candidate);
    }
    Ok(home().join(candidate))
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("\"{key}\" is required"))
}

pub async fn read_file(args: &Value) -> Result<ToolResult, String> {
    let path = resolve(string_arg(args, "path")?)?;
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?
        .len();

    let mut head = vec![0u8; SNIFF_BYTES];
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    let read = file
        .read(&mut head)
        .await
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    head.truncate(read);

    // An image is looked at, not read: the model gets the picture itself.
    if let Some(mime) = image_mime(&head) {
        if size > MAX_IMAGE_BYTES {
            return Err(format!(
                "{} is {size} bytes. Images are sent whole, and the limit is {MAX_IMAGE_BYTES}.",
                path.display()
            ));
        }

        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;

        return Ok(ToolResult {
            content: vec![
                Content::Image {
                    mime: mime.to_string(),
                    base64: STANDARD.encode(&bytes),
                },
                Content::Text(
                    json!({
                        "path": path.display().to_string(),
                        "mime": mime,
                        "bytes": bytes.len(),
                    })
                    .to_string(),
                ),
            ],
            is_error: false,
        });
    }

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    let clipped = bytes.len() > MAX_READ_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    let text = String::from_utf8_lossy(slice).to_string();

    Ok(ToolResult::text(if clipped {
        format!(
            "{text}\n\n[truncated at {MAX_READ_BYTES} bytes of {}]",
            bytes.len()
        )
    } else {
        text
    }))
}

pub async fn write_file(args: &Value) -> Result<ToolResult, String> {
    let path = resolve(string_arg(args, "path")?)?;
    let content = string_arg(args, "content")?;

    let bytes = match args.get("encoding").and_then(Value::as_str) {
        Some("base64") => STANDARD
            .decode(content)
            .map_err(|err| format!("That is not base64: {err}"))?,
        Some("utf8") | None => content.as_bytes().to_vec(),
        Some(other) => return Err(format!("\"{other}\" is not an encoding this tool writes")),
    };

    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|err| format!("Cannot create {}: {err}", dir.display()))?;
    }
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|err| format!("Cannot write {}: {err}", path.display()))?;

    Ok(ToolResult::text(format!(
        "Wrote {} bytes to {}",
        bytes.len(),
        path.display()
    )))
}

/// The image format a header says the file is, if any.
///
/// Sniffed rather than taken from the extension: a `.png` that is really a JPEG
/// still opens, and an extension the model made up is not a format.
fn image_mime(head: &[u8]) -> Option<&'static str> {
    // JPEG, skipping the variant that is not a supported stream.
    if head.len() >= 4 && head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff {
        return if head[3] == 0xf7 {
            None
        } else {
            Some("image/jpeg")
        };
    }

    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if head.len() >= 16 && head[..8] == PNG_SIGNATURE {
        // A PNG's first chunk is IHDR, and a file without one is not an image.
        let is_ihdr = head[12..16] == *b"IHDR";
        return if is_ihdr { Some("image/png") } else { None };
    }

    if head.len() >= 3 && &head[..3] == b"GIF" {
        return Some("image/gif");
    }

    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some("image/webp");
    }

    None
}

pub async fn list_dir(args: &Value) -> Result<ToolResult, String> {
    let path = resolve(string_arg(args, "path")?)?;
    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|err| format!("Cannot list {}: {err}", path.display()))?;

    let mut rows = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|err| format!("Cannot list {}: {err}", path.display()))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().await.ok();
        let kind = match meta.as_ref().map(|m| m.is_dir()) {
            Some(true) => "dir",
            _ => "file",
        };
        let size = meta.map(|m| m.len()).unwrap_or(0);
        rows.push(format!("{kind}\t{size}\t{name}"));
    }
    rows.sort();

    Ok(ToolResult::text(if rows.is_empty() {
        format!("{} is empty", path.display())
    } else {
        rows.join("\n")
    }))
}

pub async fn grep(args: &Value) -> Result<ToolResult, String> {
    let pattern = string_arg(args, "pattern")?.to_string();
    let root = resolve(args.get("path").and_then(Value::as_str).unwrap_or("~"))?;
    let ignore_case = args
        .get("ignore_case")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let needle = if ignore_case {
        pattern.to_lowercase()
    } else {
        pattern.clone()
    };

    let mut matches = Vec::new();
    for file in walk(&root) {
        if matches.len() >= MAX_GREP_MATCHES {
            break;
        }
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        // A binary file is not worth scanning for a string.
        if bytes.iter().take(1024).any(|byte| *byte == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (number, line) in text.lines().enumerate() {
            let haystack = if ignore_case {
                line.to_lowercase()
            } else {
                line.to_string()
            };
            if haystack.contains(&needle) {
                matches.push(format!(
                    "{}:{}:{}",
                    file.display(),
                    number + 1,
                    line.trim_end()
                ));
                if matches.len() >= MAX_GREP_MATCHES {
                    break;
                }
            }
        }
    }

    Ok(ToolResult::text(if matches.is_empty() {
        format!("No match for \"{pattern}\" under {}", root.display())
    } else {
        matches.join("\n")
    }))
}

pub async fn find(args: &Value) -> Result<ToolResult, String> {
    let pattern = string_arg(args, "pattern")?.to_lowercase();
    let root = resolve(args.get("path").and_then(Value::as_str).unwrap_or("~"))?;

    let found: Vec<String> = walk(&root)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase().contains(&pattern))
                .unwrap_or(false)
        })
        .take(MAX_GREP_MATCHES)
        .map(|path| path.display().to_string())
        .collect();

    Ok(ToolResult::text(if found.is_empty() {
        format!("No file named \"{pattern}\" under {}", root.display())
    } else {
        found.join("\n")
    }))
}

/// Every file under a root, bounded in count and skipping the usual noise.
fn walk(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if found.len() >= MAX_WALK_ENTRIES {
                return found;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != "." {
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(path),
                Ok(kind) if kind.is_file() => found.push(path),
                _ => {}
            }
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_formats_the_model_can_look_at() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        assert_eq!(image_mime(&png), Some("image/png"));

        assert_eq!(image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"GIF89a"), Some("image/gif"));

        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(image_mime(&webp), Some("image/webp"));
    }

    #[test]
    fn leaves_text_alone() {
        assert_eq!(image_mime(b"# a heading\n"), None);
        assert_eq!(image_mime(b"GI"), None);
        // A PNG signature without its IHDR is not a PNG.
        let mut broken = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        broken.extend_from_slice(&[0, 0, 0, 0]);
        broken.extend_from_slice(b"XXXX");
        assert_eq!(image_mime(&broken), None);
    }
}

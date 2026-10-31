//! The agent's own settings file.
//!
//! One JSON file under the user's config directory, readable by them only: it
//! holds the bearer token this instance issued at pairing. The tool groups live
//! here too, because the agent owns them: a group switched off contributes no
//! tool at all, so a model cannot call what the machine does not offer.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::tools::Group;

/// What the agent remembers between runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// This instance, without a trailing slash.
    pub url: String,
    pub token: String,
    pub device_id: String,
    /// Label the instance knows this machine by.
    pub name: String,
    /// Tool groups this machine offers.
    pub groups: Vec<Group>,
}

impl Config {
    /// The groups as a set, which is how the tool list is built.
    pub fn group_set(&self) -> BTreeSet<Group> {
        self.groups.iter().copied().collect()
    }
}

/// `$XDG_CONFIG_HOME/saale-agent/config.json`, or the home fallback.
pub fn config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("saale-agent").join("config.json")
}

/// Read the config, or explain what to run first.
pub fn load() -> Result<Config, String> {
    let path = config_path();
    let raw = fs::read_to_string(&path).map_err(|err| {
        format!(
            "No pairing found at {} ({err}). Run `saale-agent pair --url <instance> --code <code>`.",
            path.display()
        )
    })?;
    serde_json::from_str(&raw).map_err(|err| format!("{} is not readable: {err}", path.display()))
}

/// Write the config so only this user can read the token.
pub fn save(config: &Config) -> Result<(), String> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| format!("Cannot create {}: {err}", dir.display()))?;
    }

    let body =
        serde_json::to_string_pretty(config).map_err(|err| format!("Cannot encode: {err}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|err| format!("Cannot write {}: {err}", path.display()))?;
        file.write_all(body.as_bytes())
            .map_err(|err| format!("Cannot write {}: {err}", path.display()))?;
    }

    #[cfg(not(unix))]
    fs::write(&path, body).map_err(|err| format!("Cannot write {}: {err}", path.display()))?;

    Ok(())
}

/// This machine's name, as the instance will list it.
pub fn machine_name() -> String {
    let raw = fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "computer".to_string());
    let first = raw.lines().next().unwrap_or("computer").trim();
    if first.is_empty() {
        "computer".to_string()
    } else {
        first.to_string()
    }
}

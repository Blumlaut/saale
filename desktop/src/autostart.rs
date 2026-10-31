//! Start at login.
//!
//! An XDG autostart entry, which every desktop reads: the agent comes up in the
//! tray when the user signs in, so a chat can use the machine without anyone
//! launching it first. Started with `--hidden`, because the tray is the door and
//! the window opens when it is clicked.

use std::path::{Path, PathBuf};

use crate::app::executable;

/// `$XDG_CONFIG_HOME/autostart/saale-agent.desktop`, or the home fallback.
pub fn path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(base.join("autostart").join("saale-agent.desktop"))
}

/// The entry that starts `exec` at login, hidden in the tray.
pub fn entry(exec: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Saale Agent\n\
         Comment=Let a Saale chat use this computer\n\
         Exec=\"{}\" --hidden\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n",
        exec.display()
    )
}

/// Is this machine set to start the agent at login?
pub fn enabled() -> bool {
    path().map(|path| path.exists()).unwrap_or(false)
}

/// Start at login from now on. An AppImage is launched again as itself.
pub fn install() -> Result<(), String> {
    let path = path().ok_or("No home directory to start from")?;
    let exec = executable().ok_or("Cannot tell where this app lives")?;
    let entry = entry(&exec);

    if std::fs::read_to_string(&path).is_ok_and(|current| current == entry) {
        return Ok(());
    }

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("Cannot create {}: {err}", dir.display()))?;
    }
    std::fs::write(&path, entry).map_err(|err| format!("Cannot write {}: {err}", path.display()))
}

/// Leave the login session alone.
pub fn remove() -> Result<(), String> {
    let Some(path) = path() else {
        return Ok(());
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Cannot remove {}: {err}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_hidden_in_the_tray() {
        let entry = entry(Path::new("/opt/saale agent/saale-agent"));

        assert!(entry.contains("Exec=\"/opt/saale agent/saale-agent\" --hidden"));
        assert!(entry.contains("X-GNOME-Autostart-enabled=true"));
        assert!(entry.starts_with("[Desktop Entry]"));
    }
}

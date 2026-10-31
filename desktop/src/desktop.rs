//! What this app tells the desktop about itself.
//!
//! A desktop entry, so `saale://` links land here and a taskbar can match the
//! window to an icon, plus the icon itself in the user's theme. Both are written
//! once per run; a change is a rewrite.

use std::path::PathBuf;

/// The file to launch again: the AppImage itself when running from one, since it
/// runs from a temporary mount.
pub fn executable() -> Option<PathBuf> {
    std::env::var("APPIMAGE")
        .map(PathBuf::from)
        .ok()
        .or_else(|| std::env::current_exe().ok())
        .filter(|path| !path.as_os_str().is_empty())
}

/// What the window tells the shell, so a taskbar can find this entry.
const WM_CLASS: &str = "saale-agent";

/// The app icon, from `desktop/icons/icon.png`.
const ICON: &[u8] = include_bytes!("../icons/icon.png");

/// Put this app in the user's menus once: the handler for `saale://` links and
/// the icon a taskbar looks up by name.
///
/// Saale's "Open in the desktop app" button is the whole pairing step, and it
/// only works if something claims the scheme. A first run installs the entry,
/// so the second click lands.
pub fn install() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let Some(exec) = executable() else {
        return;
    };

    install_entry(&home, &exec);
    install_icon(&home);
}

pub fn install_icon_only() {
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        install_icon(&home);
    }
}

fn install_entry(home: &std::path::Path, exec: &std::path::Path) {
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
         MimeType=x-scheme-handler/saale;\n\
         StartupWMClass={WM_CLASS}\n",
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

/// Put the app icon where a shell looks for it.
///
/// The entry names `Icon=saale-agent`, and a theme lookup that finds nothing
/// draws a generic window. The icon is in the binary, so this is a copy.
pub fn install_icon(home: &std::path::Path) {
    let path = home
        .join(".local/share/icons/hicolor/256x256/apps")
        .join("saale-agent.png");
    if path.exists() {
        return;
    }
    if let Some(dir) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(dir) {
            println!("Cannot create {}: {err}", dir.display());
            return;
        }
    }
    if let Err(err) = std::fs::write(&path, ICON) {
        println!("Cannot write {}: {err}", path.display());
    }
}

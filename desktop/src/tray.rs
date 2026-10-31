//! The tray icon, and the switches that live in it.
//!
//! A StatusNotifierItem over D-Bus: no toolkit, no window, and it works on KDE,
//! XFCE and anywhere else that hosts tray icons. GNOME needs the AppIndicator
//! extension for it to show at all.
//!
//! The menu owns the tool groups and the start-at-login switch. Flipping one
//! changes what this process offers straight away, and writes it to the config
//! so the next run starts that way.

use std::sync::Arc;

use ksni::menu::{CheckmarkItem, Disposition, MenuItem, StandardItem};
use ksni::{Handle, Tray as StatusNotifier, TrayMethods};

use crate::tools::{self, Group, Groups};

/// Bring the window up. Absent on a machine nobody sits in front of.
pub type OpenWindow = Arc<dyn Fn() + Send + Sync>;

/// The tray icon and its menu.
pub struct Tray {
    groups: Groups,
    name: String,
    autostart: bool,
    open: Option<OpenWindow>,
}

impl StatusNotifier for Tray {
    fn id(&self) -> String {
        "saale-agent".to_string()
    }

    fn title(&self) -> String {
        format!("Saale — {}", self.name)
    }

    fn icon_name(&self) -> String {
        "preferences-system".to_string()
    }

    /// A left click on the icon opens Saale.
    fn activate(&mut self, _x: i32, _y: i32) {
        if let Some(open) = &self.open {
            open();
        }
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let enabled = tools::enabled(&self.groups);
        let mut items = Vec::new();

        items.push(MenuItem::Standard(StandardItem {
            label: format!("Saale — {}", self.name),
            enabled: false,
            disposition: Disposition::Informative,
            ..Default::default()
        }));
        items.push(MenuItem::Separator);

        if self.open.is_some() {
            items.push(MenuItem::Standard(StandardItem {
                label: "Open Saale".to_string(),
                icon_name: "window-new".to_string(),
                activate: Box::new(|tray: &mut Tray| {
                    if let Some(open) = &tray.open {
                        open();
                    }
                }),
                ..Default::default()
            }));
            items.push(MenuItem::Separator);
        }

        for group in Group::ALL {
            let label = group_label(group);
            items.push(MenuItem::Checkmark(CheckmarkItem {
                label: label.to_string(),
                checked: enabled.contains(&group),
                enabled: true,
                visible: true,
                activate: Box::new(move |tray: &mut Tray| {
                    let now = tools::toggle(&tray.groups, group);
                    tray.remember();
                    println!("{label} {}", if now { "on" } else { "off" });
                }),
                ..Default::default()
            }));
        }

        items.push(MenuItem::Separator);
        items.push(MenuItem::Checkmark(CheckmarkItem {
            label: "Start at login".to_string(),
            checked: self.autostart,
            enabled: true,
            visible: true,
            activate: Box::new(|tray: &mut Tray| {
                tray.autostart = !tray.autostart;
                let changed = if tray.autostart {
                    crate::autostart::install()
                } else {
                    crate::autostart::remove()
                };
                if let Err(err) = changed {
                    println!("{err}");
                }
                tray.remember();
            }),
            ..Default::default()
        }));

        items.push(MenuItem::Separator);
        items.push(MenuItem::Standard(StandardItem {
            label: "Quit".to_string(),
            icon_name: "application-exit".to_string(),
            activate: Box::new(|_| std::process::exit(0)),
            ..Default::default()
        }));

        items
    }
}

impl Tray {
    /// Keep the switches and the login setting for the next run.
    fn remember(&self) {
        let Ok(mut config) = crate::config::load() else {
            println!("Cannot read the config to keep the tool groups");
            return;
        };
        let mut groups = tools::enabled(&self.groups).into_iter().collect::<Vec<_>>();
        groups.sort();
        config.groups = groups;
        config.autostart = self.autostart;
        if let Err(err) = crate::config::save(&config) {
            println!("Cannot keep the tool groups: {err}");
        }
    }
}

fn group_label(group: Group) -> &'static str {
    match group {
        Group::Screen => "Screen",
        Group::Mouse => "Mouse",
        Group::Keyboard => "Keyboard",
        Group::Files => "Files",
        Group::Terminal => "Terminal",
    }
}

/**
 * Put the icon on the bus.
 *
 * The handle keeps it there, so the caller holds it for as long as the agent
 * runs. A machine with no session bus has no tray, which is not a failure: the
 * agent keeps answering over its channel.
 */
pub async fn spawn(
    groups: Groups,
    name: String,
    open: Option<OpenWindow>,
    autostart: bool,
) -> Result<Handle<Tray>, String> {
    let tray = Tray {
        groups,
        name,
        autostart,
        open,
    };
    tray.spawn()
        .await
        .map_err(|err| format!("No tray icon: {err}"))
}

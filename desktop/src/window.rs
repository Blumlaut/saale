//! The window: pairing, the tool switches, and whether the channel is up.
//!
//! This is the whole UI. It pairs a machine without a terminal, owns the same
//! switches the tray has, and shows what the channel is doing. Closing it leaves
//! nothing behind: the agent only runs while the window says so, or headless
//! from `saale-agent run`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use eframe::egui;

use crate::backends::Desktop;
use crate::config::{self, Config};
use crate::relay::Relay;
use crate::tools::{self, Group, Groups};

/// What the window and the agent thread share.
pub struct Shared {
    pub config: Option<Config>,
    pub groups: Groups,
    pub status: String,
    pub busy: bool,
    pub error: Option<String>,
    /// Set while the channel thread runs.
    pub running: Arc<AtomicBool>,
    /// Repaints the window when the channel thread has news.
    pub ctx: Option<egui::Context>,
}

impl Shared {
    /// Tell the window something changed, from any thread.
    pub fn repaint(&self) {
        if let Some(ctx) = &self.ctx {
            ctx.request_repaint();
        }
    }

    pub fn say(&mut self, line: impl Into<String>) {
        self.status = line.into();
        self.repaint();
    }
}

/// The window's own state.
pub struct Window {
    shared: Arc<Mutex<Shared>>,
    url: String,
    code: String,
}

impl Window {
    pub fn new(shared: Arc<Mutex<Shared>>) -> Window {
        let (url, code) = deep_link(std::env::args().skip(1));
        Window {
            shared,
            url: url.unwrap_or_else(|| "http://localhost:3630".to_string()),
            code: code.unwrap_or_default(),
        }
    }

    /// Pair this machine, off the UI thread.
    fn pair(&self) {
        let url = self.url.trim().trim_end_matches('/').to_string();
        let code = self.code.trim().to_string();
        let shared = self.shared.clone();

        {
            let mut state = shared.lock().expect("the window state");
            if state.busy {
                return;
            }
            state.busy = true;
            state.error = None;
        }

        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();

            let outcome = match runtime {
                Ok(runtime) => runtime.block_on(async {
                    let groups = {
                        let state = shared.lock().expect("the window state");
                        tools::enabled(&state.groups)
                    };
                    Relay::pair(
                        &url,
                        &code,
                        &config::machine_name(),
                        &tools::new_groups(groups),
                    )
                    .await
                }),
                Err(err) => Err(format!("Cannot start the pairing: {err}")),
            };

            let mut state = shared.lock().expect("the window state");
            state.busy = false;
            match outcome {
                Ok(body) => {
                    let Some(token) = body.get("token").and_then(|value| value.as_str()) else {
                        state.error = Some("The instance did not send a token".to_string());
                        state.repaint();
                        return;
                    };
                    let config = Config {
                        url: url.clone(),
                        token: token.to_string(),
                        device_id: body
                            .get("deviceId")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        name: body
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("computer")
                            .to_string(),
                        groups: tools::enabled(&state.groups).into_iter().collect(),
                    };
                    if let Err(err) = config::save(&config) {
                        state.error = Some(err);
                        state.repaint();
                        return;
                    }
                    state.status = "Paired. Start it when you are ready.".to_string();
                    state.config = Some(config);
                }
                Err(err) => state.error = Some(err),
            }
            state.repaint();
        });
    }

    /// Start or stop the channel, off the UI thread.
    fn toggle_channel(&self) {
        let shared = self.shared.clone();

        let (config, stop, groups) = {
            let mut state = shared.lock().expect("the window state");

            if state.running.load(Ordering::Relaxed) {
                state.running.store(false, Ordering::Relaxed);
                state.say("Stopped");
                return;
            }

            let Some(config) = state.config.clone() else {
                state.error = Some("Pair this computer first".to_string());
                return;
            };

            let stop = state.running.clone();
            stop.store(true, Ordering::Relaxed);
            state.say("Connecting...");
            (config, stop, state.groups.clone())
        };

        std::thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    let mut state = shared.lock().expect("the window state");
                    state.error = Some(format!("Cannot start the channel: {err}"));
                    stop.store(false, Ordering::Relaxed);
                    state.repaint();
                    return;
                }
            };

            let relay = Relay::new(&config.url, &config.token);
            let sink = shared.clone();
            runtime.block_on(relay.run(
                groups,
                Desktop::new(),
                stop.clone(),
                Arc::new(move |line: &str| {
                    if let Ok(mut state) = sink.lock() {
                        state.say(line);
                    }
                }),
            ));

            stop.store(false, Ordering::Relaxed);
        });
    }

    /// Keep the switches in the config, so the next run starts that way.
    fn remember_groups(&self) {
        let state = self.shared.lock().expect("the window state");
        let Some(mut config) = state.config.clone() else {
            return;
        };
        let mut groups = tools::enabled(&state.groups)
            .into_iter()
            .collect::<Vec<_>>();
        groups.sort();
        config.groups = groups;
        drop(state);
        if let Err(err) = config::save(&config) {
            let mut state = self.shared.lock().expect("the window state");
            state.error = Some(err);
        }
    }
}

impl eframe::App for Window {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        {
            let mut state = self.shared.lock().expect("the window state");
            state.ctx = Some(ctx.clone());
        }

        let mut pair = false;
        let mut toggle_channel = false;
        let mut groups_changed = false;
        let quit;

        {
            let state = self.shared.lock().expect("the window state");
            ui.heading("Saale agent");
            ui.add_space(4.0);

            match &state.config {
                None => {
                    ui.label("Pair this computer with a Saale instance.");
                    ui.add_space(8.0);
                    ui.label("Instance");
                    ui.add_enabled(
                        !state.busy,
                        egui::TextEdit::singleline(&mut self.url)
                            .hint_text("https://saale.example.com"),
                    );
                    ui.add_space(4.0);
                    ui.label("Pairing code");
                    ui.add_enabled(
                        !state.busy,
                        egui::TextEdit::singleline(&mut self.code).hint_text("ABCD-EFGH"),
                    );
                    ui.add_space(8.0);
                    pair = ui
                        .add_enabled(
                            !state.busy && !self.code.trim().is_empty(),
                            egui::Button::new(if state.busy { "Pairing..." } else { "Pair" }),
                        )
                        .clicked();
                    ui.add_space(6.0);
                    ui.label("Get a code in Saale: Settings, Integrations, This computer.");
                }
                Some(config) => {
                    ui.label(format!("Paired with {} as {}", config.url, config.name));
                    ui.label(format!("Channel: {}", state.status));
                    ui.add_space(8.0);

                    let enabled = tools::enabled(&state.groups);
                    let mut working = enabled;
                    ui.label("This computer offers");
                    for group in Group::ALL {
                        let mut on = working.contains(&group);
                        if ui.checkbox(&mut on, group.name()).changed() {
                            if on {
                                working.insert(group);
                            } else {
                                working.remove(&group);
                            }
                            tools::toggle(&state.groups, group);
                            groups_changed = true;
                        }
                    }
                    ui.add_space(10.0);
                    toggle_channel = ui
                        .button(if state.running.load(Ordering::Relaxed) {
                            "Stop"
                        } else {
                            "Start"
                        })
                        .clicked();
                }
            }

            if let Some(error) = &state.error {
                ui.add_space(8.0);
                ui.colored_label(egui::Color32::from_rgb(220, 80, 60), error);
            }

            ui.add_space(12.0);
            quit = ui.button("Quit").clicked();
        }

        if pair {
            self.pair();
        }
        if groups_changed {
            self.remember_groups();
        }
        if toggle_channel {
            self.toggle_channel();
        }
        if quit {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        // The channel thread writes into the shared state; a slow tick keeps the
        // status line honest even when nothing calls `repaint`.
        ctx.request_repaint_after(std::time::Duration::from_millis(500));
    }
}

/// A `saale://pair?url=...&code=...` link, as a launcher hands it over.
fn deep_link(args: impl Iterator<Item = String>) -> (Option<String>, Option<String>) {
    for arg in args {
        if !arg.starts_with("saale://") {
            continue;
        }
        let query = arg
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default();
        let mut url = None;
        let mut code = None;
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let decoded = percent_decode(value);
            match key {
                "url" => url = Some(decoded),
                "code" => code = Some(decoded),
                _ => {}
            }
        }
        return (url, code);
    }
    (None, None)
}

/// Enough of percent-decoding for a URL in a query string.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Open the window. Runs on the calling thread, which must be the main one.
pub fn open(shared: Arc<Mutex<Shared>>) -> Result<(), String> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Saale agent")
            .with_inner_size([420.0, 380.0])
            .with_min_inner_size([320.0, 280.0]),
        ..Default::default()
    };

    let window = Window::new(shared);
    eframe::run_native("Saale agent", options, Box::new(|_cc| Ok(Box::new(window))))
        .map_err(|err| format!("Cannot open the window: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_pairing_link() {
        let (url, code) = deep_link(
            [
                "--flag",
                "saale://pair?url=http%3A%2F%2Fsaale.example.com&code=ABCD-EFGH",
            ]
            .into_iter()
            .map(str::to_string),
        );

        assert_eq!(url.as_deref(), Some("http://saale.example.com"));
        assert_eq!(code.as_deref(), Some("ABCD-EFGH"));
    }

    #[test]
    fn has_nothing_for_a_plain_start() {
        let (url, code) = deep_link(std::iter::empty());
        assert!(url.is_none());
        assert!(code.is_none());
    }
}

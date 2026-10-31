//! Saale desktop agent.
//!
//! Runs on the computer the user wants a chat to be able to use. It connects out
//! to the Saale instance it was paired with, offers the tool groups the user
//! switched on, and answers the instance's calls. Nothing listens on this
//! machine.

mod backends;
mod config;
mod mcp;
mod relay;
mod tools;
mod tray;
mod window;

use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use backends::Desktop;
use config::Config;
use relay::Relay;

/// The release this binary belongs to, when the build set one.
pub const VERSION: &str = match option_env!("SAALE_AGENT_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

const USAGE: &str = "\
saale-agent: let a chat use this computer.

  saale-agent
      Open the window: pair this computer, choose what it offers, start it.

  saale-agent pair --url <instance> --code <code> [--groups screen,files]
      Pair this machine with a Saale instance.

  saale-agent run [--groups screen,files,terminal]
      Stay connected without a window, for a machine nobody sits in front of.

  saale-agent groups [--enable screen,mouse] [--disable terminal]
      Show or change which tool groups this machine offers.

  saale-agent status
      Show what this machine is paired with.

Tool groups: screen, mouse, keyboard, files, terminal.";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let result = match args.first().map(String::as_str) {
        Some("pair") => pair(&args[1..]).await,
        Some("run") => run(&args[1..]).await,
        Some("groups") => groups(&args[1..]),
        Some("status") => status(),
        Some("--version") | Some("-V") => {
            println!("{VERSION}");
            Ok(())
        }
        Some("--help") | Some("-h") => {
            println!("{USAGE}");
            Ok(())
        }
        // No command opens the window, which is how a desktop user pairs and
        // starts the agent. `run` stays for the boxes nobody sits in front of.
        None => open_window(),
        Some(other) => Err(format!("Unknown command \"{other}\".\n\n{USAGE}")),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

/// `--flag value` and `--flag=value`, so both forms work.
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let prefix = format!("--{name}=");
    for (index, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix(&prefix) {
            return Some(value);
        }
        if arg == &format!("--{name}") {
            return args.get(index + 1).map(String::as_str);
        }
    }
    None
}

async fn pair(args: &[String]) -> Result<(), String> {
    let url = flag(args, "url").ok_or("--url <instance> is required")?;
    let code = flag(args, "code").ok_or("--code <code> is required")?;
    let name = flag(args, "name")
        .map(str::to_string)
        .unwrap_or_else(config::machine_name);

    let groups = match flag(args, "groups") {
        Some(list) => tools::parse_list(list)?,
        None => tools::Group::default_enabled(),
    };
    let groups = tools::new_groups(groups);

    let body = Relay::pair(url, code, &name, &groups).await?;
    let token = body
        .get("token")
        .and_then(|value| value.as_str())
        .ok_or("The instance did not send a token")?;
    let device_id = body
        .get("deviceId")
        .and_then(|value| value.as_str())
        .ok_or("The instance did not send a device id")?;

    let config = Config {
        url: url.trim_end_matches('/').to_string(),
        token: token.to_string(),
        device_id: device_id.to_string(),
        name: body
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or(&name)
            .to_string(),
        groups: tools::enabled(&groups).into_iter().collect(),
    };
    config::save(&config)?;

    println!(
        "Paired as \"{}\". Start it with `saale-agent run`.",
        config.name
    );
    Ok(())
}

async fn run(args: &[String]) -> Result<(), String> {
    let mut config = config::load()?;

    if let Some(list) = flag(args, "groups") {
        config.groups = tools::parse_list(list)?;
        config::save(&config)?;
    }

    let groups = tools::new_groups(config.groups.iter().copied());
    let name = config.name.clone();
    let relay = Relay::new(&config.url, &config.token);
    let desktop = Desktop::new();
    let stop = Arc::new(AtomicBool::new(true));
    let say: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|line: &str| println!("{line}"));

    // A machine with no session bus has no tray; that is not a reason to stop.
    let _tray = match tray::spawn(groups.clone(), name).await {
        Ok(handle) => Some(handle),
        Err(err) => {
            println!("{err}. Running without one.");
            None
        }
    };

    relay.run(groups, desktop, stop, say).await;
    Ok(())
}

/// The window, with a config it reads and writes on its own.
fn open_window() -> Result<(), String> {
    let config = config::load().ok();
    let groups = tools::new_groups(
        config
            .as_ref()
            .map(|c| c.groups.clone())
            .unwrap_or_default(),
    );

    let shared = Arc::new(Mutex::new(window::Shared {
        config,
        groups,
        status: "Not running".to_string(),
        busy: false,
        error: None,
        running: Arc::new(AtomicBool::new(false)),
        ctx: None,
    }));

    window::open(shared)
}

fn groups(args: &[String]) -> Result<(), String> {
    let mut config = config::load()?;
    let mut changed = false;

    if let Some(list) = flag(args, "enable") {
        for group in tools::parse_list(list)? {
            if !config.groups.contains(&group) {
                config.groups.push(group);
                changed = true;
            }
        }
    }
    if let Some(list) = flag(args, "disable") {
        for group in tools::parse_list(list)? {
            config.groups.retain(|enabled| *enabled != group);
            changed = true;
        }
    }

    config.groups.sort();
    if changed {
        config::save(&config)?;
    }

    for group in tools::Group::ALL {
        let state = if config.groups.contains(&group) {
            "on"
        } else {
            "off"
        };
        println!("{:<9} {state}", group.name());
    }

    if changed {
        println!("\nRestart `saale-agent run` to apply this.");
    }
    Ok(())
}

fn status() -> Result<(), String> {
    let config = config::load()?;
    println!("instance  {}", config.url);
    println!("machine   {} ({})", config.name, config.device_id);
    println!("session   {}", mcp::session());
    println!(
        "groups    {}",
        config
            .groups
            .iter()
            .map(|group| group.name())
            .collect::<Vec<_>>()
            .join(", ")
    );
    Ok(())
}

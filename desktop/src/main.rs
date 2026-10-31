//! Saale desktop agent.
//!
//! Runs on the computer the user wants a chat to be able to use. It connects out
//! to the Saale instance it was paired with, offers the tool groups the user
//! switched on, and answers the instance's calls. Nothing listens on this
//! machine.
//!
//! Started with no arguments it opens Saale itself in a window, which is how a
//! desktop user pairs and uses it. `saale-agent run` is the same agent without a
//! window, for a machine nobody sits in front of.

mod app;
mod autostart;
mod backends;
mod config;
mod desktop;
mod mcp;
mod relay;
mod tools;
mod tray;

use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

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

  saale-agent [--url <instance>] [--hidden]
      Open Saale in a window, paired with this computer. Pairing from Saale's
      settings page fills this in; --url points it at an instance before then.
      --hidden starts it in the tray, which is how a login does it.

  saale-agent pair --url <instance> --code <code> [--groups screen,files]
      Pair this machine without a window.

  saale-agent run [--groups screen,files,terminal]
      Stay connected without a window, for a machine nobody sits in front of.

  saale-agent groups [--enable screen,mouse] [--disable terminal]
      Show or change which tool groups this machine offers.

  saale-agent status
      Show what this machine is paired with.

Tool groups: screen, mouse, keyboard, files, terminal.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let result = match args.first().map(String::as_str) {
        Some("pair") => runtime().block_on(pair(&args[1..])),
        Some("run") => runtime().block_on(run(&args[1..])),
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
        // A `saale://pair?...` link, or no command at all: the window.
        Some(_) | None => window(&args),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

/// A tokio runtime for the parts that talk to the instance.
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a tokio runtime")
}

/// `--flag value` and `--flag=value`, so both forms work.
fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

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

    let config = pair_now(url, code, &name, groups).await?;
    println!(
        "Paired as \"{}\". Start it with `saale-agent`.",
        config.name
    );
    Ok(())
}

/// Trade a code for a token and keep it. Shared by the command line and the
/// window, which arrives here from a `saale://pair` link.
async fn pair_now(
    url: &str,
    code: &str,
    name: &str,
    groups: Vec<tools::Group>,
) -> Result<Config, String> {
    let groups = tools::new_groups(groups);
    let body = Relay::pair(url, code, name, &groups).await?;

    let token = body
        .get("token")
        .and_then(|value| value.as_str())
        .ok_or("The instance did not send a token")?;

    let config = Config {
        url: url.trim_end_matches('/').to_string(),
        token: token.to_string(),
        device_id: body
            .get("deviceId")
            .and_then(|value| value.as_str())
            .ok_or("The instance did not send a device id")?
            .to_string(),
        name: body
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or(name)
            .to_string(),
        groups: tools::enabled(&groups).into_iter().collect(),
        autostart: true,
    };

    config::save(&config)?;
    Ok(config)
}

async fn run(args: &[String]) -> Result<(), String> {
    let mut config = config::load()?;
    desktop::install_icon_only();

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
    let _tray = match tray::spawn(groups.clone(), name, None, autostart::enabled()).await {
        Ok(handle) => Some(handle),
        Err(err) => {
            println!("{err}. Running without one.");
            None
        }
    };

    relay.run(groups, desktop, stop, say).await;
    Ok(())
}

/// Open Saale in a window, pairing first when the launch carried a link.
fn window(args: &[String]) -> Result<(), String> {
    let link = app::PairLink::from_args(args.iter().cloned());
    let requested = link.url.or_else(|| flag(args, "url").map(str::to_string));

    let mut config = config::load().ok();

    // Arriving from Saale's "Open in the desktop app" button: the link carries
    // both halves, so this is the whole pairing step. The instance is kept even
    // if the code is stale, so the window still lands on the right Saale.
    if let Some(url) = requested.clone() {
        if let Err(err) = config::save_instance(&url) {
            println!("{err}");
        }
    }

    if let (Some(url), Some(code)) = (requested.clone(), link.code) {
        println!("Pairing with {url}...");
        match pair_with(&url, &code, config.as_ref()) {
            Ok(paired) => {
                println!("Paired as \"{}\".", paired.name);
                config = Some(paired);
            }
            Err(err) => {
                // Show Saale anyway: the code can be minted again from there,
                // and typing the instance a second time is not the user's job.
                println!("Pairing failed: {err}");
                println!("Open Settings, Integrations, This computer in Saale to try again.");
            }
        }
    }

    // Show what this machine is paired with, or what to do about it.
    let url = config
        .as_ref()
        .map(|config| config.url.clone())
        .or(requested)
        .or_else(config::load_instance);
    let device_id = config.as_ref().map(|config| config.device_id.clone());

    // The next "Open in the desktop app" click has to find this app.
    desktop::install();

    let tray_options = config.clone().map(|config| {
        let options = app::TrayOptions {
            groups: tools::new_groups(config.groups.iter().copied()),
            name: config.name.clone(),
            autostart: config.autostart,
        };
        start_agent(config);
        options
    });

    // Keep this machine in the login session, unless the user turned that off.
    if let Some(options) = &tray_options {
        let changed = if options.autostart {
            autostart::install()
        } else {
            autostart::remove()
        };
        if let Err(err) = changed {
            println!("{err}");
        }
    }

    // A login starts in the tray; an unpaired machine has nothing to hide in.
    let hidden = has_flag(args, "--hidden") && tray_options.is_some();

    // The same click from inside the window: the page hands over `saale://pair`,
    // this pairs, starts answering and gives back the instance to show.
    let on_link: app::OnPairLink = Arc::new(move |link: app::PairLink, handle| {
        let (Some(url), Some(code)) = (link.url, link.code) else {
            println!("A pairing link needs both an instance and a code");
            return None;
        };
        let current = config::load().ok();

        match pair_with(&url, &code, current.as_ref()) {
            Ok(paired) => {
                println!("Paired as \"{}\".", paired.name);
                start_agent(paired.clone());
                if let Err(err) = autostart::install() {
                    println!("{err}");
                }
                app::start_tray_for(
                    &handle,
                    app::TrayOptions {
                        groups: tools::new_groups(paired.groups.iter().copied()),
                        name: paired.name.clone(),
                        autostart: paired.autostart,
                    },
                );
                Some(paired.url)
            }
            Err(err) => {
                println!("Pairing failed: {err}");
                None
            }
        }
    });

    app::open(url, device_id, hidden, tray_options, on_link)
}

/// Trade a code for a token, keeping the groups this machine already offers.
fn pair_with(url: &str, code: &str, current: Option<&Config>) -> Result<Config, String> {
    let name = config::machine_name();
    let groups = current
        .map(|config| config.groups.clone())
        .unwrap_or_else(tools::Group::default_enabled);
    runtime().block_on(pair_now(url, code, &name, groups))
}

/// Answer the instance for as long as the window is open, on its own runtime.
fn start_agent(config: Config) {
    let groups = tools::new_groups(config.groups.iter().copied());
    let relay = Relay::new(&config.url, &config.token);
    let desktop = Desktop::new();
    let stop = Arc::new(AtomicBool::new(true));

    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(err) => {
                println!("Cannot start the agent: {err}");
                return;
            }
        };

        runtime.block_on(async move {
            let say: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|line: &str| println!("{line}"));
            relay.run(groups, desktop, stop, say).await;
        });
    });
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
        println!("\nRestart `saale-agent` to apply this.");
    }
    Ok(())
}

fn status() -> Result<(), String> {
    let config = config::load()?;
    println!("instance  {}", config.url);
    println!("machine   {} ({})", config.name, config.device_id);
    println!("session   {}", mcp::session());
    println!(
        "login     {}",
        if autostart::enabled() {
            "starts in the tray"
        } else {
            "not started at login"
        }
    );
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

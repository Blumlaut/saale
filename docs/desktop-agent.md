# Desktop agent

A small app the user installs on their own machine. Saale reaches it as an MCP
server over a channel the app opens, so the machine needs no inbound port and
no tunnel. Linux first, X11 and Wayland.

## Shape

One app, three surfaces, one core:

- **Tray and window.** Starts at login from `~/.config/autostart/saale-agent.desktop`
  with `--hidden`, so it comes up in the tray. Closing the window hides it there,
  and a left click or **Open Saale** brings it back. Without a tray to hide into
  — no session bus, or GNOME without the AppIndicator extension — the window
  stays visible and closing it quits, because hiding it would leave no way in.
  The window renders `saale.example.com` in a plain webview with no IPC access,
  so page JavaScript can never reach the input APIs.
- **Switches in the tray.** The menu owns the tool groups and **Start at login**,
  which writes or removes the autostart entry and keeps the choice in the
  config. Saale's integrations page carries the same groups, so neither surface
  is the only way in.
- **Headless.** `saale-agent --headless`, no window, for machines where nobody
  signs into Saale's UI.

Pairing comes from the deep link `saale://pair?url=…&code=…`. Saale's settings
page shows the code and fires that link, so the instance travels with it and the
agent never asks for it: `~/.config/saale-agent/config.json` holds it once
paired, `~/.config/saale-agent/instance` holds it from the first link on. The
first run writes its own `saale-agent.desktop` so the scheme has a handler.

## Saale side

- `Device` model: name, platform, token hash, capabilities, last seen, revoked.
- Pairing route plus a Devices section under settings → connections.
- Relay: SSE down, POST up, the terminal panel's pattern. The device dials out.
- Transport: a `McpTransportFactory` passed to `createMcpExtension` at
  `src/lib/mcp/servers.ts:193`. It wraps the device socket in the five members
  of `McpTransport` and keeps the GET stream open, so
  `notifications/tools/list_changed` reaches the session and a tray switch
  changes the running chat's tool list.
- Approval: the device server's policy is `ask`. The existing gate and card
  handle it, including the cross-process wait and the Telegram path.
- Summary: a branch in `resolveToolSummary` for device tools, so the card reads
  `Click at 812,340 on DISPLAY-1` instead of raw arguments.
- Audit: every device tool call recorded with its summary and outcome.

## Capability groups

The agent decides what exists, and the switches live in Saale's settings page and
in the tray. Flipping one sends `notifications/saale/groups` over the device
channel; the agent applies it, keeps it for the next run, and answers with a
hello so the page shows what the machine actually took. A notification rather
than a tool, because the model must not be able to reach it.

A blocked tool is missing from `tools/list`, so the model cannot see it, call it,
or find it in codemode.

| Group    | Tools                                                             |
| -------- | ----------------------------------------------------------------- |
| Screen   | `screenshot`, `list_windows`                                      |
| Mouse    | `click`, `double_click`, `move`, `drag`, `scroll`                 |
| Keyboard | `type_text`, `press_key`, `focus_window`                          |
| Files    | `fs_read`, `fs_write`, `fs_edit`, `fs_list`, `fs_grep`, `fs_find` |
| Terminal | `run_command`                                                     |

No clipboard tools.

A shell subsumes the file suite, so Terminal is the switch that matters. Files
exists for hosts where the shell stays off. Both are refused at execute time as
well, for a stale tool list.

The file tools are surfaced as Pi's own read, edit, list, grep and find
definitions, backed by the device the way `infra-tools.ts` backs them with SFTP.
The diff view, image reads and truncation then work unchanged. The raw MCP tools
are hidden from the model.

## Coordinates

The client owns the mapping. Two factors sit between the model's pixel and the
pointer.

1. The screenshot is downscaled to the model's image budget. The factor is
   recorded in the tool result.
2. Screen pixels differ from the logical coordinate space input injection uses
   once display scaling is on.

`screenshot` returns the image plus, per stream, the monitor id, its origin, its
size and both factors. `click` takes the monitor and coordinates in that image's
pixel space. The client maps image → stream logical → injection space. Absolute
desktop coordinates from the model are refused, since they go stale the moment
the layout changes.

`get_pointer` returns the current cursor position for a sanity check. A
coordinate grid overlay is a cheap option when the model keeps missing.

## X11

`xcap` for capture and `enigo` for input. Both are solid on X11. Monitor
geometry comes from the X server, so origins and scale are read directly.

## Wayland

Wayland has no global pointer, no global window list and no synthetic input by
default. The portals are the sanctioned path.

### What each compositor offers

| Compositor       | Capture                               | Input                                            | Window list            |
| ---------------- | ------------------------------------- | ------------------------------------------------ | ---------------------- |
| GNOME 43+        | ScreenCast + PipeWire                 | RemoteDesktop `Notify*`, `ConnectToEIS` on newer | none                   |
| KDE Plasma 5.27+ | ScreenCast + PipeWire                 | RemoteDesktop                                    | KWin D-Bus scripting   |
| sway and wlroots | ScreenCast via xdg-desktop-portal-wlr | no RemoteDesktop, needs uinput                   | `wlr-foreign-toplevel` |
| Hyprland         | its portal, or `hyprctl`              | probe at startup                                 | `hyprctl`              |

`xdg-desktop-portal-wlr` implements Screenshot and ScreenCast only, which is why
wlroots needs the uinput fallback for input.

### Capture

`xcap` already speaks Wayland: on a wlroots compositor it reads through
libwayshot, and elsewhere it calls the `Screenshot` portal over D-Bus and takes
the file it returns. That is a working capture on GNOME and KDE today, at the
price of one consent dialog per grab, which is why the ScreenCast session is
still the goal:

- Create one session on the RemoteDesktop portal, call
  `Screencast::select_sources` on it, start it once.
- `persist_mode = 2` plus the restore token keeps the dialog from returning.
- Frames come from a PipeWire consumer holding the latest buffer, so a
  `screenshot` costs a frame copy rather than a capture session.

### Input

The agent drives the pointer and keyboard over the RemoteDesktop portal, through
`ashpd` directly:

- One session, `select_devices` with keyboard and pointer, and a monitor source
  on the same session so absolute motion has a space to point in.
- `notify_pointer_motion_absolute` takes the stream's node id and a point in its
  logical space, `notify_pointer_button` takes evdev codes, `notify_pointer_axis`
  takes smooth scroll deltas, and `notify_keyboard_keysym` types by keysym.
- `persist_mode = 2` plus a restore token in `~/.config/saale-agent/portal-token`
  keeps the consent dialog from returning. Persistence belongs to the
  RemoteDesktop portal for a combined session, so the ScreenCast call carries no
  persist options.
- A failed call drops the session, so the next one asks for a fresh one instead
  of talking to a dead object path.

`enigo`'s own `libei_tokio` path would be lower latency, but it unwraps its
portal connection and panics where no portal answers, which kills the agent.
EIS stays a later optimisation.

The uinput fallback for wlroots creates a real virtual device through
`/dev/uinput`. It needs a udev rule, installed by the deb and printed by the
AppImage on first run. It works on every compositor, at the price of a one-time
root step.

### Window list

There is no cross-compositor API. `list_windows` and `focus_window` are
advertised only where the environment supports them: KWin scripting on Plasma,
`wlr-foreign-toplevel` on sway, `hyprctl` on Hyprland. On GNOME Wayland they are
absent, and the agent falls back to `press_key` for alt-tab.

## Dependencies

| Crate                                                                                        | Job                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `ashpd` (screencast, remote_desktop, screenshot, notification, background, global_shortcuts) | portals, consent, autostart, hotkey, toasts |
| `pipewire`, `libspa`                                                                         | frame grab from the ScreenCast node         |
| `image`, `fast_image_resize`                                                                 | encode and downscale for the model          |
| `enigo`, `xcap`                                                                              | the X11 path                                |
| `reis` (optional)                                                                            | EIS input                                   |
| `evdev` / `uinput`                                                                           | wlroots input fallback                      |
| `wayland-client`, `wayland-protocols-wlr`                                                    | foreign-toplevel on wlroots                 |
| `rmcp`                                                                                       | MCP server over the device socket           |
| `tauri`, `tray-icon`, updater, deep-link                                                     | shell                                       |

Build dependencies: `libpipewire-0.3-dev`, `libspa-0.2-dev`, `libclang`,
`libxdo-dev`, `libxkbcommon-dev`.

`ashpd`'s `global_shortcuts` portal gives the panic hotkey on Wayland, where a
global key grab is otherwise impossible.

## Packaging

AppImage first, plus a tarball, from the release workflow. No signing on Linux.
A checkout packages its own with `npm run agent:package` and serves it from
`public/downloads/`, so a development build offers a real download instead of a
release asset that does not exist yet.

The AppImage carries everything the agent links against, including the libraries
it opens by name at runtime (`libxkbcommon-x11` on X11), which `ldd` cannot see.

**The webview is not bundled, and that is deliberate.** Tauri's own AppImage
guide treats WebKitGTK as a host package: it asks for a build on the oldest base
system that provides `libwebkit2gtk-4.1-dev`, because bundling the webview ties
the AppImage to one GTK and glib. So:

- The AppImage is built on Debian 12, which sets the glibc floor and is where
  `libwebkit2gtk-4.1` comes from.
- At startup the AppRun checks for `libwebkit2gtk-4.1.so.0` and says
  `install libwebkit2gtk-4.1-0` instead of failing silently. Every GNOME, KDE
  and XFCE install has it; a bare window manager may not.
- `saale-agent run` needs no webview at all, so a box without it still answers
  over the channel, and a user without the app can drive the agent from Saale in
  their own browser.

Flatpak is out: `run_command` needs the host, and a sandbox cannot provide it.

The AppImage sets a fixed desktop file name so the portal can key its persisted
permissions to one app id. Without it every launch looks like a new app and the
consent dialog returns.

## Built so far

- `desktop/` is a Rust binary that pairs, holds the channel and answers MCP. It
  builds in CI and ships with each release as
  `saale-agent-<version>-x86_64-linux.tar.gz`.
- Saale has the `Device` model, pairing codes, the relay over Redis, the
  `DeviceTransport`, and the settings card that offers the download and the
  pairing command.
- The newest user message decides which computer a chat may reach
  (`ChatMessage.clientDeviceId`, set from the cookie the agent's window writes).
  A message from anywhere else takes the machine away at once: the approval gate
  re-reads the newest message on every device tool call, and a run prompted by
  another client rebuilds the session without the device.
- The file tools hand an image to the model as an image: `read_file` sniffs the
  header (png, jpeg, gif, webp) and returns the picture plus its path, mime and
  size, and `write_file` writes base64 when asked, so a generated image lands on
  the filesystem and can be read back.
- Screen capture, the pointer and the keyboard work on X11: a real capture, a
  click mapped from the image, typing and key combinations. Verified under Xvfb
  against the live instance.
- Wayland capture rides on `xcap`'s Screenshot portal path, and Wayland input on
  the RemoteDesktop portal. Both are written but untested here: this machine has
  no compositor.
- The tray is a StatusNotifierItem over D-Bus, with a checkmark per tool group.
  Flipping one takes effect in the running process.
- The window is Saale itself in a WebKitGTK webview with no IPC, which is the
  shell the plan describes. It sets the `saale_client` cookie so a chat started
  in the window is bound to this computer, and it pairs from a
  `saale://pair?url=…&code=…` link that Saale's settings page fires.
  `saale-agent run` stays headless.
- Every device tool call is recorded with its summary and outcome, and the
  settings card shows the last few. The ScreenCast frame session, `focus_window`
  and the pairing window are still open.

## Milestones

| Step | Work                                                                                                                              | Time   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M0   | Saale relay, transport factory, fake device returning a generated screenshot. Pins the tool contract and the coordinate metadata. | 3 days |
| M1   | X11 client: capture, mouse, keyboard, the coordinate mapping                                                                      | 1 week |
| M2   | Wayland: portal session, PipeWire frames, D-Bus input, GNOME first                                                                | 1 week |
| M3   | Files and terminal groups, capability gating, audit log                                                                           | 3 days |
| M4   | Shell: tray, autostart, deep-link pairing, capability window, updater                                                             | 1 week |
| M5   | wlroots input fallback, window tools per compositor                                                                               | 3 days |

## Risks

- Portal versions vary by distro. The client probes `RemoteDesktop.version` and
  `AvailableDeviceTypes` at startup and hides what the host cannot do.
- PipeWire consumers need their own loop thread. A frame store of one buffer is
  enough, and it keeps the tool call off the capture path.
- GNOME offers no window API at all. Two of the twelve tools stay absent there.
- uinput needs root once. The install has to say so plainly.
- Consent is per app id. A moved AppImage that changes its app id loses the
  persisted permission.

# Desktop agent

A small app the user installs on their own machine. Saale reaches it as an MCP
server over a channel the app opens, so the machine needs no inbound port and
no tunnel. Linux first, X11 and Wayland.

## Shape

One app, three surfaces, one core:

- **Tray and window.** Autostarts at login. Closing the window leaves it in the
  tray. The window renders `saale.example.com` in a plain webview with no IPC
  access, so page JavaScript can never reach the input APIs.
- **Capability window.** A local page with IPC, reachable from the tray. Owns
  the switches, the connection state, the audit log and pairing.
- **Headless.** `saale-agent --headless`, no window, for machines where nobody
  signs into Saale's UI.

Pairing comes from the deep link `saale://pair/<code>`. Saale's settings page
shows the code, the app registers itself against the signed-in session.

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

The client decides what exists. A blocked tool is missing from `tools/list`, so
the model cannot see it, call it, or find it in codemode.

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

One session for both screen and input: create it on the RemoteDesktop portal,
call `Screencast::select_sources` on that same session, then start it. The user
sees one consent dialog. `persist_mode = 2` plus the restore token keeps it from
reappearing; the token is stored in `~/.config/saale-agent/` and refreshed on
each start.

`Screencast::start` returns streams with a PipeWire node id, a logical `size` and
a `position`, which is the monitor layout the coordinate mapping needs. Frames
come from a PipeWire consumer holding the latest buffer, so a `screenshot` call
costs one frame copy instead of a new capture session.

The `Screenshot` portal is the fallback for a single grab. Its prompting
behaviour differs per backend, so it is not the loop path.

### Input

`RemoteDesktop::notify_pointer_motion_absolute` takes the stream id and
coordinates in that stream's space, so the portal does the layout mapping for
us. `notify_keyboard_keysym` types by X11 keysym, including `0x01000000 +
codepoint` for arbitrary Unicode. Clicks, drags, scrolls and typing all work over
D-Bus with no native dependency.

`ConnectToEIS` plus `reis` is the lower-latency path for smooth drags. `reis` is
incomplete, so D-Bus first, EIS behind a flag.

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

AppImage and deb, from one GitHub Actions matrix. No signing on Linux.

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
- Screen capture is a placeholder with the real metadata contract. Mouse,
  keyboard, the portal session and the tray are still open.

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

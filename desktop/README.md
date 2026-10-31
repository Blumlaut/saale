# Saale desktop agent

Lets a chat use the computer it was started from. The agent runs on that machine,
connects out to your Saale instance, and answers the instance's calls. Nothing
listens on the machine, so no port forwarding and no tunnel.

The newest message in a chat decides which computer its agent may reach. A message
from another client — a plain browser tab, a phone, Telegram — takes the machine
away immediately, and a device tool call made after it is refused.

## Install

Download the build from **Settings → Integrations → This computer**, or take the
asset named `saale-agent-<version>-x86_64-linux.tar.gz` from the release your
instance runs.

```sh
tar xzf saale-agent-2026.10.2-x86_64-linux.tar.gz
sudo install -m 755 saale-agent /usr/local/bin/saale-agent
```

## Pair

Run `saale-agent` with no arguments. The window asks for the instance and a
code, which you get in **Settings → Integrations → This computer → Connect a
computer**. A `saale://pair?url=…&code=…` link fills both in.

On a machine nobody sits in front of, the command line does the same:

```sh
saale-agent pair --url https://saale.example.com --code ABCD-EFGH
saale-agent run
```

The token it receives lands in `~/.config/saale-agent/config.json`, readable by
your user only. Pair again to rotate it.

## The window

`saale-agent` opens a window: the pairing form, the five group switches and a
Start button. It is the whole UI, with no browser in it.

## The tray

`saale-agent run` puts an icon in the tray. Its menu lists the five groups as
checkmarks: flipping one takes effect in the running process, so the tool list
changes without a restart, and the choice is written to the config.

GNOME shows tray icons only with the AppIndicator extension; KDE and XFCE show
them as they are. Without a tray host the agent says so once and keeps running.

## Tool groups

The agent owns these switches. A group that is off contributes no tool, so the
model cannot call it and cannot find it in a codemode script.

| Group    | Tools                                                 |
| -------- | ----------------------------------------------------- |
| screen   | `screenshot`                                          |
| files    | `read_file`, `write_file`, `list_dir`, `grep`, `find` |
| terminal | `run_command`                                         |
| mouse    | none yet                                              |
| keyboard | none yet                                              |

```sh
saale-agent groups                    # what is on
saale-agent groups --enable terminal  # turn one on
saale-agent groups --disable files
```

`terminal` runs commands as you, with no sandbox. It is off by default.

## What this build does and does not do

- The channel, pairing, the tool list and the group switches are done.
- `read_file` sniffs the header: png, jpeg, gif and webp come back as an image
  to look at, everything else as text. `write_file` takes `encoding: "base64"`
  so an image can be saved and read back.
- Screen, pointer and keyboard work on X11. A capture is downscaled to 1568px,
  and a click is mapped from that image back onto the display, so the model
  never has to think in desktop pixels.
- Wayland capture goes through `xcap`'s Screenshot portal, which asks once per
  grab. Wayland input goes through the RemoteDesktop portal: one consent dialog,
  then a restore token so it does not come back.
- The tray is a StatusNotifierItem over D-Bus. There is no window yet: pairing is
  still the command line, and there is no autostart.

## Development

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo run -- status
```

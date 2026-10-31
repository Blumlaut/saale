# Saale desktop agent

Lets a chat use the computer it was started from. The agent runs on that machine,
connects out to your Saale instance, and answers the instance's calls. Nothing
listens on the machine, so no port forwarding and no tunnel.

A chat only reaches the computer it was started from. A chat opened from Telegram,
from a phone, or from a plain browser tab gets no computer at all.

## Install

Download the build from **Settings → Integrations → This computer**, or take the
asset named `saale-agent-<version>-x86_64-linux.tar.gz` from the release your
instance runs.

```sh
tar xzf saale-agent-2026.10.2-x86_64-linux.tar.gz
sudo install -m 755 saale-agent /usr/local/bin/saale-agent
```

## Pair

Get a code in **Settings → Integrations → This computer → Connect a computer**,
then:

```sh
saale-agent pair --url https://saale.example.com --code ABCD-EFGH
saale-agent run
```

The token it receives lands in `~/.config/saale-agent/config.json`, readable by
your user only. Pair again to rotate it.

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
- `screenshot` returns a placeholder image with the metadata contract a click
  will map through. Real capture (ScreenCast and PipeWire on Wayland, X11
  otherwise) is next, and the mouse and keyboard groups land with it.
- `saale-agent run` is the whole UI for now: no tray, no window, no autostart.

## Development

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo run -- status
```

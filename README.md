# Saale

A self-hosted chat UI that doesn't waste your tokens.

## Why should I care?

Saale was built on the idea that legacy is no excuse for bad practices. It runs on
[Pi](https://github.com/earendil-works/pi-coding-agent), so the common inference providers
work out of the box. Saale adds only the few things it takes to make working with a local
provider pleasant.

You skip the pile of environment variables. Saale is set up once with Docker Compose,
which brings its dependencies with it, and from then on you work entirely in the web UI.

Every account gets a workspace the model can use, and the user decides which tools it may
reach there. Files and images you upload are handed to the model and kept in that
workspace; they go when you delete the chat.

There is also a Coder mode, with worktrees, git history and management, a terminal and a
file browser.

## How do you save tokens?

Saale leans on Pi's `codemode`. The model looks up the tools it needs and calls them from a
small JavaScript script, so it writes tool calls the way it writes code. One script does
the work of several calls, and the model keeps every tool it might need.

A Saale prompt with the basic productivity tools uses **less than 6,000 tokens**.

## What else can Saale do?

The Agent can pretty much do anything a Linux machine can, install programs, execute code, do web searches, if you can think of it, it probably can do it.

Saale itself brings a normal set of productivity tools: mail over SMTP and IMAP, a calendar, a
to-do list, agents, schedules and watchers.

- **Agents** are prompts that run on a schedule and do the work on their own.
- **Schedules** are jobs Saale runs on its own: mail and calendar sync, chat titles, tags,
  memory compaction.
- **Watchers** run a script when a file or a repository changes. A fire opens a chat and
  hands the result to the model, opens a coder chat, or stays silent.

It also works as a coding environment, with Monaco (VS Code's editor) built in. It supports
worktrees and a full set of repository tools. Connect GitHub once in Settings, under
Integrations, and your private repositories, pushes and pull requests work from the
workspace.

## Screenshots

**Chat.** A conversation with the agent. Answers stream in as markdown, and each turn
shows the tools it used. Here it drafted a launch note, checked the calendar and the mail
to pick a send time, and sent it.

![Chat](docs/screenshots/chat.png)

**Coder.** A chat in a worktree of the `relay` repo. The panel shows the branch, what is
staged and what is not, the project's scripts and the recent commits.

![Coder](docs/screenshots/coder.png)

## Setup

Docker with Compose v2, and a domain if you want HTTPS and coder previews.

```bash
git clone https://github.com/Blumlaut/saale.git
cd saale
cp .env.example .env                            # fill in the four secrets
docker compose -f docker-compose.prod.yml up -d
```

That pulls the published images; nothing is built. `docker-compose.yml` builds the same
stack from the checkout, which is what changing the code uses.

Open <http://localhost:3630> and create the first account, which is the admin. The agent
needs a model: add a provider key in Settings.

## Docs

| Page                                       | What is in it                                    |
| ------------------------------------------ | ------------------------------------------------ |
| [Install](docs/install.md)                 | Compose, ports, a domain, TLS, updates, backups  |
| [Configuration](docs/configuration.md)     | Every environment variable that matters          |
| [Coder previews](docs/previews.md)         | A wildcard domain for dev servers in a workspace |
| [Firefox sidebar](docs/firefox-sidebar.md) | Using Saale as Firefox's AI chatbot provider     |
| [Development](docs/development.md)         | A checkout, the test suite, demo data            |

## Naming

**Saale** is a river through Jena.

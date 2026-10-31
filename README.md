<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
  <img src="docs/assets/wordmark.svg" alt="Saale" width="260">
</picture>

A self-hosted chat UI that doesn't waste your tokens.

## Why should I care?

Saale was built on the idea that legacy is no excuse for bad practices. It runs on
[Pi](https://pi.dev), so the common inference providers
work out of the box. Saale adds only the few things it takes to make working with a local
provider pleasant.

One Docker Compose file brings up the whole stack: app, worker, Postgres, Redis, the speech
and search sidecars. Four secrets in `.env`, and everything else happens in the web UI.

Every account gets a workspace of its own. It runs in its own container, on its own
directory of the workspace volume, so no other user's files are reachable from it, and the
user decides which tools the model may reach there. Uploaded files and images are handed to
the model and kept with the chat until it is deleted.

There is also a Coder mode, with worktrees, git history and management, a terminal and a
file browser.

## How does it save tokens?

Saale leans on Pi's `codemode`. The model looks up the tools it needs and calls them from a
small JavaScript script, the way it writes code. Several calls fit in one script.

A Saale prompt with the basic productivity tools uses **less than 6,000 tokens**.

## What else can Saale do?

The agent runs in a Linux container, so it installs packages, executes code and searches the
web.

Saale itself brings a normal set of productivity tools: mail over SMTP and IMAP, a calendar,
a to-do list, infrastructure management (SSH connections, notes), memories, agents,
schedules and watchers.

- **Agents** are prompts that run on a schedule and do the work on their own.
- **Schedules** are jobs Saale runs on its own: mail and calendar sync, chat titles, tags,
  memory compaction.
- **Watchers** are a script on a schedule. It runs in the same sandbox as a chat's
  `codemode`, with every tool to hand, so it watches a repository, a mailbox, a calendar or
  anything else a tool reaches and acts on what changed. A fire lands in a chat, in a coder
  chat, or nowhere when the script handles it itself.

Monaco (VS Code's editor) is built in for edits. Connect GitHub under Settings →
Integrations for private repositories, pushes and pull requests.

## Multi-User?

Yes, with permission groups. Providers come in two kinds: global ones an admin configures,
and local ones each user sets up for themselves.

## Infrastructure Management?

Saale connects to and manages servers over SSH. The host needs a reachable SSH port, and
either a key configured in Saale or password authentication enabled.

## Screenshots

**Chat.** A conversation with the agent. Answers stream in as markdown, and each turn shows
the tools it used. Here it drafted a launch note, checked the calendar and the mail to pick
a send time, and sent it.

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

That runs the published images. `docker-compose.yml` builds the same stack from a checkout.

Open <http://localhost:3630> and create the first account, which is the admin. Add a
provider key in Settings so the agent has a model.

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

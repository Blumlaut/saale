# GitHub

Saale reaches GitHub in one of two ways, and a workspace carries exactly one of
them at a time:

| Source         | What it is                                                                                                         | What it can reach                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **GitHub App** | one app per instance, authorized per account, installed on the accounts and organizations that should be reachable | only where it is installed, and a single chat only its project's repository |
| **GitHub CLI** | the `gh auth login` the workspace already knows                                                                    | everything the account can see                                              |

The app is the narrower one: an installation is the ceiling GitHub enforces, an
installation token can be cut further per chat, and the workspace stores no
long-lived credential. The CLI login needs no setup at all, which is why an
instance that keeps it keeps working exactly as before.

## What an admin does once

### 1. Register the app

At <https://github.com/settings/apps/new> (or under an organization, if the
instance is meant to reach its repositories):

| Field                                          | Value                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Homepage URL                                   | the instance's public URL (`BETTER_AUTH_URL`)                                                                |
| Callback URL                                   | `<public url>/api/integrations/github/callback` — required by the form, unused: the sign-in is a device flow |
| **Enable Device Flow**                         | **on.** Without it GitHub answers `device_flow_disabled`                                                     |
| Request user authorization during installation | off                                                                                                          |
| Webhook → Active                               | off                                                                                                          |
| Setup URL                                      | `<public url>/api/integrations/github/installed` (see step 3)                                                |
| Redirect on update                             | on                                                                                                           |

Repository permissions — the rest stays "No access":

| Permission    | Level          | Why                                            |
| ------------- | -------------- | ---------------------------------------------- |
| Contents      | Read and write | clone, fetch, push                             |
| Pull requests | Read and write | open and read pull requests                    |
| Workflows     | Read and write | push a branch that touches `.github/workflows` |
| Checks        | Read           | the check badge on a branch                    |
| Metadata      | Read           | mandatory                                      |

Then generate a **private key** (a `.pem`, downloadable once) and a **client
secret**. The app id and the client id are on the same page.

### 2. Save it in Saale

**Admin → Settings → GitHub**: app id, client id, client secret, private key →
**Save and verify**. Saale signs a JWT with the key and reads `GET /app`, so a
wrong id or key is refused at the form instead of failing in the first chat. The
secret and the key are stored encrypted and never shown again.

The app can be switched off there without deleting it. Removing it deletes the
installations and every token an account authorized with it; the authorization
itself stays at GitHub, under "Authorized GitHub Apps".

### 3. Point the app's Setup URL at Saale

`<public url>/api/integrations/github/installed` is where GitHub sends the
browser after an installation or a change to its repository access. Nothing from
those query parameters is trusted — Saale re-reads the installations with the
account's own token. The route only drops the one-minute mark that holds a
re-read back, so the card shows the new repositories immediately.

## What an account does

**Settings → Integrations → GitHub → Connect GitHub**: a device code, typed at
`https://github.com/login/device`. Saale stores the user-to-server token (eight
hours, refreshed for six months of use) and lists the installations that account
may use.

**Install on GitHub** (or _Manage repositories_, when an installation exists)
opens GitHub's install page. The choice of repositories happens there, not in
Saale: it is GitHub's security boundary, and the app cannot install itself.

Once installed, **the repository set can be changed in Saale**: the button on an
installation opens a picker of the repositories that account administers, and
saving adds or removes them through
`PUT`/`DELETE /user/installations/{id}/repositories/{repo_id}`. An installation
granted "All repositories" cannot be narrowed this way — GitHub only removes from
an installation that was switched to "Only select repositories", and the picker
says so.

## What happens in a workspace

The account's choice is applied when the card is read, after a sign-in or
sign-out, and before a command that talks to a remote:

- **App source.** `~/.gitconfig` holds one credential helper for `github.com`
  (`~/.local/bin/saale-git-credential`), a token file lives at
  `~/.saale/github.json`, a `gh` shim at `~/.local/bin/gh` gives the agent's own
  `gh` the same token, and `gh` is signed out of the workspace so nothing answers
  beside it.
- **CLI source.** Those three are removed; `gh`'s own login, which Saale never
  touches, is what commands use.

In a **coder chat** the token is narrower still: Saale mints an installation
token for that chat's repository alone (`contents`, `pull_requests`, `workflows`
write, `checks` read) and puts it in the command's `GH_TOKEN`. Both the git
helper and the shim prefer a token from the environment, so `git push` and
`gh pr create` in that chat cannot reach another repository. Nothing is minted
for a repository the installation does not cover — the chat then falls back to
the workspace credential rather than to something wider.

Tokens live one hour and are cached until a minute before they expire; a token
already minted for a repository that was removed keeps working until then,
because GitHub does not revoke installation tokens when an installation shrinks.

### Instance-wide setting

`admin.githubMethod` decides what the instance offers: `choice` (default, both),
`cli` (only the CLI, the app is not offered) or `app` (only the app — a CLI login
found in a workspace is removed rather than adopted). An instance set to `app`
without an app saved keeps the permissive behaviour and warns; `admin.githubMode`
is read on every reconcile, so changing it takes effect at the next read.

## When something does not work

| What you see                                     | Why                                                                    | Fix                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GitHub refused these credentials` when saving   | app id and key do not belong together, or the key was truncated        | paste the whole `.pem`, including the BEGIN/END lines                     |
| `The private key could not be read`              | the pasted key is not a PEM file (both PKCS#1 and PKCS#8 are accepted) | download it again from the app's settings                                 |
| The card says `Not installed on any account yet` | authorization succeeded, installation did not                          | open the install page and pick repositories                               |
| A push fails with `403` in a chat                | the installation does not cover that repository                        | add it in the picker, or on GitHub for an "All repositories" installation |
| Commands use the old login after switching       | the reconcile is throttled to a minute                                 | read the card again, or wait a minute                                     |

## Several accounts on one instance

The app belongs to the instance; the connection belongs to the person.

| Where                      | What                                                     |
| -------------------------- | -------------------------------------------------------- |
| `GithubApp`                | the credentials an admin saved, shared by every account  |
| `GithubInstallation`       | one row per installation on GitHub, whoever installed it |
| `GithubUserToken`          | each account's own authorization (8 h, refreshed)        |
| `GithubInstallationAccess` | which installations one account may use                  |
| `AppSettings.githubSource` | per account: `""`, `app` or `cli`                        |

So a second account uses the same app without any admin work: it connects in
_Settings → Integrations → GitHub_, authorizes the app with its own GitHub
login, and sees the installations GitHub says it can reach — its own, and those
of organizations it is a member of. An installation on somebody else's personal
account stays invisible, because GitHub does not grant it.

Two things decide what a stranger gets:

- **“Any account”** at app registration. On “Only this account”, other accounts
  can authorize the app but cannot install it, so they reach no repository.
- **Who installs it, sets the ceiling.** The installer picks the repositories
  (or grants all), and Saale narrows further per chat. Changing the set later
  needs admin access on the repository, which is why a plain member sees an
  empty picker.

Signing one account out removes only its own token and access rows; the
installation stays, because another account may still use it. Deleting the app
in the admin panel removes everything.

## Who appears on GitHub

An installation token authenticates the _app_, so work it carries reads as
`<slug>[bot]` — a commit with the bot as committer, a pull request with the bot
as author and the person only as a footnote. Two things keep the person in the
history:

| Where                        | What                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| the workspace's `.gitconfig` | `[user]` is the connected account and its `users.noreply.github.com` address, so GitHub links the commit to the profile |
| `gh pr create`               | runs with the account's own token (`resolveGithubUserEnv`), so the pull request's author is the account, not the app    |

Everything else in a chat keeps the narrowed installation token: pushes are
still limited to the chat's repository. Attribution changes who is _recorded_,
not what a command may touch.

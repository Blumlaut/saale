# Security Policy

## Reporting a Vulnerability

Report it privately through GitHub's [private vulnerability
reporting](https://github.com/Blumlaut/saale/security/advisories/new). Do not open
a public issue for a security concern.

You get an acknowledgement within 48 hours, and a critical issue is fixed within
7 days.

## Scope

Saale holds mail, files and SSH credentials for one person, and an agent runs
commands in that person's workspace. Reports that matter most:

- Anything that lets one account read or act on another account's data.
- Anything that lets a command leave its own workspace, or reach a service inside
  the deployment's network.
- A secret that reaches a log, an error message, a share link or the model.

Include what you ran, what you expected, and what happened. A proof of concept
against a local `docker compose up` is the most useful form.

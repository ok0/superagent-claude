# Getting started

## Install

Requirements: Node.js 22.19 or later, pnpm, git 2.32 or later, and gh 2.48 or later.

From a checkout:

```sh
pnpm install
pnpm build
```

The binary is `lib/cli.js`. After `pnpm link --global` it runs as `superagent-claude`.

## Agent account

The agent needs a separate GitHub account with a personal access token in `SUPERAGENT_CLAUDE_GITHUB_TOKEN`. The account must be able to read the target repositories. Write (push) access lets it push agent branches and open pull requests. Without write access it still receives events, replies and prepares a worktree, and a code change stops as blocked with a request to grant the agent account write access.

New work starts only from an issue or comment that mentions the agent account as `@<login>`, where `<login>` is the agent account's login, for example `@agent-bot please fix the typo`. An issue without the mention is ignored silently: the agent posts nothing on it and starts no work. Comments from allowed people on an issue or pull request the agent already works on reach that work without a new mention.

Do not put the agent account's login in `policy.allowed`. superagent-claude refuses to start if you do.

## Start

```sh
superagent-claude start [--config <path>]
```

This is the one start command. It runs in the foreground, with one process per state directory. Use `--fake` to run the scripted runtime, which makes no model calls.

SIGHUP reloads the config. The keys `repositories`, `policy.*`, `auth.owner`, `auth.acceptSubscriptionSharedUseRisk`, `network.allow`, `models.worker` and `retention.endedTicketDays` apply on reload. The other keys need a restart.

The other commands:

- `superagent-claude status` shows running work, idle sessions, waiting tickets, recent errors, repository access and consent. It reads the state database, so it works while the daemon runs.
- `superagent-claude needs` lists the tickets that wait for a person. `--all` adds the other open tickets and the tickets ended within `retention.endedTicketDays`.
- `superagent-claude prompts diff` shows the built-in prompt changes since the team sections were made.

Exit codes: 0 done, 1 unknown argument, 2 refused start or config error, 3 no readable state database (status, needs).

To run it as a service, see [deploy.md](deploy.md).

The default `policy.acceptMode` is `observe`. `auto` must be set explicitly.

## Next

- [configuration.md](configuration.md)
- [authentication.md](authentication.md)
- [security.md](security.md)

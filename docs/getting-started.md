# Getting started

## Install

Requirements: Node.js 22.19 or later, git 2.32 or later, and gh 2.48 or later.

```sh
npm i -g superagent-claude
```

This installs the `superagent-claude` command. To run it without a global install, use `npx superagent-claude <command>`.

To build from source instead, you also need pnpm. From a checkout:

```sh
pnpm install
pnpm build
```

The binary is then `lib/cli.js`, for example `node lib/cli.js start --config superagent-claude.json`. After `pnpm link --global` it runs as `superagent-claude`.

## Agent account

The agent needs a separate GitHub account with a personal access token in `SUPERAGENT_CLAUDE_GITHUB_TOKEN`. The account must be able to read the target repositories. Write (push) access lets it push agent branches and open pull requests. Without write access it still receives events, replies and prepares a worktree, and a code change stops as blocked with a request to grant the agent account write access.

New work starts only from an issue or comment that mentions the agent account as `@<login>`, where `<login>` is the agent account's login, for example `@agent-bot please fix the typo`. An issue without the mention is ignored silently: the agent posts nothing on it and starts no work. Comments from allowed people on an issue or pull request the agent already works on reach that work without a new mention.

Do not put the agent account's login in `policy.allowed`. superagent-claude refuses to start if you do.

## Start

```sh
superagent-claude start [--config <path>]
```

This is the one start command. It runs in the foreground, with one process per state directory. Use `--fake` to run the scripted runtime, which makes no model calls. Add `--log-format json` to write one JSON event per line on stdout; see [deploy.md](deploy.md#json-logs).

SIGHUP reloads the config. The keys `repositories`, `policy.*`, `auth.owner`, `auth.acceptSubscriptionSharedUseRisk`, `network.allow`, `models.worker`, `retention.endedTicketDays`, `review.*` and the per-repository `branchFrom` and `pullRequestTo` settings apply on reload. For `repositories`, a reload changes admission at once, but polling of an added or removed repository starts or stops only after a restart. The other keys (`auth.mode`, `delivery.*`, `workers.*`, `security.*`, `models.router` and `stateDir`) need a restart.

The other commands:

- `superagent-claude status` shows running work, idle sessions, waiting tickets, recent errors, repository access and consent. It reads the state database, so it works while the daemon runs.
- `superagent-claude needs` lists the tickets that wait for a person. `--all` adds the other open tickets and the tickets ended within `retention.endedTicketDays`.
- `superagent-claude prompts diff` shows the built-in prompt changes since the team sections were made.
- `superagent-claude health --ready` or `--live` exits 0 when the daemon is ready for work (`--ready`) or live (`--live`), 1 otherwise; see [deploy.md](deploy.md#probes-and-stopping).

Exit codes: 0 done, 1 unknown command (or a failed `health` check), 2 unknown option, refused start or config error, 3 no readable state database (status, needs).

To run it as a service, see [deploy.md](deploy.md).

The default `policy.acceptMode` is `observe`. `auto` must be set explicitly. See [configuration.md](configuration.md) for the three values.

## Next

- [configuration.md](configuration.md)

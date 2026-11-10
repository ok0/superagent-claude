# superagent-claude

> Research project at an early stage. Behavior, configuration and interfaces will change. It is not ready for production use.

superagent-claude is a proactive coding agent for GitHub repositories. Powered by Claude. It polls the repositories you configure. When a person on the allowlist asks it for work, it opens a ticket, does the work in its own session and git worktree, and answers in the original conversation, for example with a pull request.

## How it works

Take as little human attention as possible, and give as much value as possible. The agent acts only when an allowed person asks or when a rule you wrote allows it, and it speaks only when someone must act or can use a result.

## Install

Requirements: Node.js 22.19 or later, pnpm, git 2.32 or later, and gh 2.48 or later.

From a checkout:

```sh
pnpm install
pnpm build
```

The binary is `lib/cli.js`. After `pnpm link --global` it runs as `superagent-claude`.

## Agent account

The agent needs a separate GitHub account with a personal access token in `SUPERAGENT_CLAUDE_GITHUB_TOKEN`. The account must be able to read the target repositories. Push access lets it open branches in them. Without push it works from a fork.

Do not put the agent account's login in `policy.allowed`. superagent-claude refuses to start if you do.

## Start

```sh
superagent-claude start [--config <path>]
```

This is the one start command. It runs in the foreground, with one process per state directory. Use `--fake` to run the scripted runtime, which makes no model calls.

SIGHUP reloads the config. The keys `repositories`, `policy.*`, `auth.owner`, `auth.acceptSubscriptionSharedUseRisk`, `network.allow`, `models.worker` and `retention.endedTicketDays` apply on reload. The other keys need a restart.

The other commands:

- `superagent-claude status` shows running work, waiting tickets, recent errors, repository access and consent. It reads the state database, so it works while the daemon runs.
- `superagent-claude needs` lists the tickets that wait for a person. `--all` adds the other open tickets and the tickets ended within `retention.endedTicketDays`.
- `superagent-claude prompts diff` shows the built-in prompt changes since the team sections were made.

Exit codes: 0 done, 1 unknown argument, 2 refused start or config error, 3 no readable state database (status, needs).

To run it as a service, see [docs/deploy.md](docs/deploy.md).

## Configuration

The config file `superagent-claude.json` has 20 settings.

Required:

- `auth.mode` and its Claude credential (see Authentication)
- `SUPERAGENT_CLAUDE_GITHUB_TOKEN` in the environment
- `repositories`
- `policy.allowed`

Everything else has a default.

| Key | Default |
| --- | --- |
| `repositories` | required, one or more `owner/name` |
| `policy.allowed` | required, one or more logins |
| `policy.acceptMode` | `observe` |
| `policy.rules` | built-in rules |
| `policy.admission` | built-in table |
| `auth.mode` | `api-key` |
| `auth.owner` | unset |
| `auth.acceptSubscriptionSharedUseRisk` | `false` |
| `delivery.forkWhenNoPush` | `true` |
| `delivery.allowAutoMerge` | `false` |
| `workers.max` | `2` |
| `workers.maxTurns` | `100` |
| `workers.maxBudgetUsd` | `5` |
| `network.allow` | `[]` |
| `security.trustRepoConfig` | `false` |
| `security.allowUnsandboxed` | `false` |
| `retention.endedTicketDays` | `14` |
| `models.router` | unset |
| `models.worker` | unset |
| `stateDir` | `~/.superagent-claude` |

The default `policy.acceptMode` is `observe`. `auto` must be set explicitly.

A minimal config:

```json
{
  "repositories": ["owner/repo"],
  "policy": { "allowed": ["alice"] },
  "auth": { "mode": "api-key" }
}
```

## Authentication

Set `auth.mode` to one of four values. Each needs the environment named in its section.

### api-key

Set `auth.mode` to `api-key`. Set `ANTHROPIC_API_KEY`.

### bedrock

Set `auth.mode` to `bedrock`. Set `AWS_REGION`, and either `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. `AWS_SESSION_TOKEN` is optional.

### vertex

Set `auth.mode` to `vertex`. Set `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, and Google application default credentials (`GOOGLE_APPLICATION_CREDENTIALS`).

### subscription

Set `auth.mode` to `subscription`. Set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

This mode runs the agent on a Claude subscription. Automated use is a gray area of the subscription terms, and superagent-claude prints a warning on every start.

Owner-only use means `auth.owner` is set and `policy.allowed` is exactly `[auth.owner]`. Any other allowlist is shared use. Shared use is a ToS risk, and superagent-claude refuses to start unless `auth.acceptSubscriptionSharedUseRisk` is `true`. The consent (its time and the allowed list hash) is logged and shown by `superagent-claude status`.

superagent-claude refuses to start when:

- the credential for `auth.mode` is missing
- `policy.allowed` is empty
- `repositories` is empty
- the agent account's login is in `policy.allowed`
- the subscription is shared and no consent is given
- `auto` is set without a sandbox, unless `security.allowUnsandboxed` is set
- no repository is accessible
- `SUPERAGENT_CLAUDE_GITHUB_TOKEN` is missing

## Documentation

- [docs/runtime-contract.md](docs/runtime-contract.md)

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

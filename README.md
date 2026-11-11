# superagent-claude

superagent-claude is a proactive coding agent for GitHub repositories. Powered by Claude. It polls the repositories you configure. When a person on the allowlist asks it for work, it opens a ticket, does the work in its own session and git worktree, and answers in the original conversation, for example with a pull request.

Take as little human attention as possible, and give as much value as possible. The agent acts only when an allowed person asks or when a rule you wrote allows it, and it speaks only when someone must act or can use a result.

![Flow: an allowed person mentions the agent, allowlist admission, a ticket, its own session and git worktree, then a reply comment or a pull request](docs/assets/flow.svg)

## Quick start

```sh
npm i -g superagent-claude
export SUPERAGENT_CLAUDE_GITHUB_TOKEN=<agent account token>
export ANTHROPIC_API_KEY=<API key>                     # either: API key
export CLAUDE_CODE_OAUTH_TOKEN=<token>                 # or: Claude subscription (token from `claude setup-token`)
superagent-claude start --config superagent-claude.json
```

It needs Node.js 22.19 or later. `npx superagent-claude start --config superagent-claude.json` runs it without a global install.

`auth.mode` picks which one (`api-key` or `subscription`); Bedrock and Vertex also work. See [docs/authentication.md](docs/authentication.md) for both modes and the subscription terms warning.

The config needs `repositories`, `policy.allowed` and `auth.mode`. See [docs/getting-started.md](docs/getting-started.md), which also covers building from source.

A container image is published as `ghcr.io/ok0/superagent-claude`. See [Docker](docs/deploy.md#docker) to run it.

## Documentation

- [Getting started](docs/getting-started.md): install, agent account, start
- [Configuration](docs/configuration.md): settings and defaults
- [Authentication](docs/authentication.md): auth modes and start refusals
- [Runtime contract](docs/runtime-contract.md)
- [Deploy](docs/deploy.md): run as a service
- [Security](docs/security.md): trust policy
- [Contributing](CONTRIBUTING.md): setup, checks and pull requests

## Test repositories

Live tests write only to the repository named by `SUPERAGENT_CLAUDE_LIVE_REPO` and may read the optional `SUPERAGENT_CLAUDE_LIVE_REPORT_REPO`. Without these settings the live tests that need GitHub are skipped. Seed the playground with `pnpm live:seed` (`pnpm live:seed --upgrade` replaces an older seed in one commit) and clean it with `pnpm live:cleanup`. See [Run live tests against your own playground](CONTRIBUTING.md#run-live-tests-against-your-own-playground). The project's own live runs use [ok0/superagent-claude-playground](https://github.com/ok0/superagent-claude-playground) as the playground.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

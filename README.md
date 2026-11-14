# issuecrew

![Four requests, three allowed, each in its own git worktree at the same time, ending in two pull requests and one reply](docs/assets/hero.svg)

issuecrew is a proactive coding agent for GitHub repositories. Powered by Claude. It polls the repositories you configure. When a person on the allowlist asks it for work, it opens a ticket, does the work in its own session and git worktree, and answers in the original conversation, for example with a pull request.

Take as little human attention as possible, and give as much value as possible. The agent acts only when an allowed person asks or when a rule you wrote allows it, and it speaks only when someone must act or can use a result.

## How it works

![Flow: an allowed person mentions the agent, allowlist admission, a ticket, its own session and git worktree, then a reply comment or a pull request](docs/assets/flow.svg)

## Quick start

```sh
npm i -g issuecrew
export ISSUECREW_GITHUB_TOKEN=<agent account token>
export ANTHROPIC_API_KEY=<API key>                     # either: API key
export CLAUDE_CODE_OAUTH_TOKEN=<token>                 # or: Claude subscription (token from `claude setup-token`)
issuecrew start --config issuecrew.json
```

It needs Node.js 22.19 or later. `npx issuecrew start --config issuecrew.json` runs it without a global install.

`auth.mode` picks which one (`api-key` or `subscription`); Bedrock and Vertex also work. See [docs/authentication.md](docs/authentication.md) for both modes and the subscription terms warning.

The config needs `repositories` and `policy.allowed`; `auth.mode` defaults to `api-key` and needs its credential. See [docs/getting-started.md](docs/getting-started.md), which also covers building from source.

A container image is published as `ghcr.io/ok0/issuecrew`. See [Docker](docs/deploy.md#docker) to run it.

## Documentation

- [Getting started](docs/getting-started.md): install, agent account, start
- [Configuration](docs/configuration.md): settings and defaults
- [Authentication](docs/authentication.md): auth modes and start refusals
- [Runtime contract](docs/runtime-contract.md)
- [Deploy](docs/deploy.md): run as a service
- [Running multiple accounts/projects](docs/deploy.md#running-multiple-accountsprojects): one instance per account or project
- [Security](docs/security.md): trust policy
- [Contributing](CONTRIBUTING.md): setup, checks and pull requests

## Works with issuecrew-planner

![issuecrew and issuecrew-planner: each works on its own, and the planner's GitHub issues can optionally feed the agent](docs/assets/works-with.svg)

Each tool works on its own, and they can be used together. issuecrew handles one request in one repository at a time. For a change that spans several repositories, [issuecrew-planner](https://www.npmjs.com/package/issuecrew-planner) splits it into one GitHub issue per repository, with a shared contract and a merge order, and mentions the agent in each issue. issuecrew then works through those issues like any other request. You don't need the planner to use the agent.

## Known limitations

The worker cannot run end-to-end tests that need services, databases, browsers or Docker inside the sandbox, and it has no per-ticket setup: it does not prepare dependencies in each ticket's worktree. Both are open for later review. See [Known limitations](docs/deploy.md#known-limitations).

## Test repositories

Live tests write only to the repository named by `ISSUECREW_LIVE_REPO` and may read the optional `ISSUECREW_LIVE_REPORT_REPO`. Without these settings the live tests that need GitHub are skipped. Seed the playground with `pnpm live:seed` (`pnpm live:seed --upgrade` replaces an older seed in one commit) and clean it with `pnpm live:cleanup`. See [Run live tests against your own playground](CONTRIBUTING.md#run-live-tests-against-your-own-playground). The project's own live runs use [ok0/issuecrew-playground](https://github.com/ok0/issuecrew-playground) as the playground.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

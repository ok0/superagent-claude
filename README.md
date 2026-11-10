# superagent-claude

> Research project at an early stage. Behavior, configuration and interfaces will change. It is not ready for production use.

superagent-claude is a proactive coding agent for GitHub repositories. Powered by Claude. It polls the repositories you configure. When a person on the allowlist asks it for work, it opens a ticket, does the work in its own session and git worktree, and answers in the original conversation, for example with a pull request.

Take as little human attention as possible, and give as much value as possible. The agent acts only when an allowed person asks or when a rule you wrote allows it, and it speaks only when someone must act or can use a result.

![Flow: an allowed person mentions the agent, allowlist admission, a ticket, its own session and git worktree, then a reply comment or a pull request](docs/assets/flow.svg)

## Quick start

```sh
pnpm install && pnpm build
export SUPERAGENT_CLAUDE_GITHUB_TOKEN=<agent account token>
export ANTHROPIC_API_KEY=<API key>
node lib/cli.js start --config superagent-claude.json
```

The config needs `repositories`, `policy.allowed` and `auth.mode`. See [docs/getting-started.md](docs/getting-started.md).

## Documentation

- [Getting started](docs/getting-started.md): install, agent account, start
- [Configuration](docs/configuration.md): settings and defaults
- [Authentication](docs/authentication.md): auth modes and start refusals
- [Runtime contract](docs/runtime-contract.md)
- [Deploy](docs/deploy.md): run as a service
- [Security](docs/security.md): trust policy

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

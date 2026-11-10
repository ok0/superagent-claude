# Contributing to superagent-claude

Thanks for helping improve superagent-claude. This guide covers setup, the checks, and how to open a pull request.

## Development setup

- Node.js 22.19 or newer (CI and the container image use Node.js 24).
- pnpm 11. The exact version is the `packageManager` field in `package.json`, for example `npm install --global pnpm@11.28.11`.

```sh
git clone https://github.com/ok0/superagent-claude.git
cd superagent-claude
pnpm install --frozen-lockfile
pnpm build
```

## Tests

- `pnpm test`: the offline suite. It needs no network, no credentials and no Docker. Every pull request must pass it.
- `pnpm test:live`: the tests under `tests/live/` that run against real GitHub test repositories and a real model. They need credentials (`SUPERAGENT_CLAUDE_LIVE=1`, an agent token, an owner token, model auth) and are skipped without them. Run them by hand on your own machine only.

CI never runs the live tests.

## Checks

`pnpm check:all` runs every check CI runs: typecheck, the offline tests, the build, `check:branding` and `check:commits`. It stops at the first failure and exits non-zero. It does not build the container image.

To check the container image locally, you need Docker. CI builds the image but never pushes it.

```sh
docker build -t superagent-claude:local .
bash scripts/check-image-secrets.sh superagent-claude:local
```

## Commit messages

Use Conventional Commits: `type(scope)?: subject`. Allowed types are feat, fix, docs, style, refactor, perf, test, build, ci, chore and revert. `pnpm check:commits` checks every commit reachable from HEAD.

No AI attribution: do not add AI co-author trailers, "generated with" lines, session links or other AI attribution or session markers to commit messages, pull requests or code.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the change focused. Update the tests and docs that the change affects.
3. Run `pnpm check:all` and make sure it passes.
4. Open the pull request and fill in the template.

CI runs on every push and pull request. It uses no secrets and runs the same way for forks. A maintainer reviews and merges the change.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

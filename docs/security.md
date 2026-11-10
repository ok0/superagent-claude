# Security and trust policy

Text from the hosting service is untrusted. The agent works in a git worktree per ticket, with tool, network and permission limits.

## Repository settings that run code

Sessions use `settingSources: []`: the repository's `.claude/settings.json` and `settings.local.json` hooks, permission rules and CLAUDE.md are not loaded. `.mcp.json` is ignored (`strictMcpConfig`); the only MCP server is the host-provided `superagent` server.

Git hooks: the clone's `core.hooksPath` points to an empty directory, re-set on every prepare, and every host git call passes `-c core.hooksPath=<empty dir>`, so `.husky` or any repository hook path does not run.

Opt-in `security.trustRepoConfig: true` sets `settingSources: ['project']`: the repository's project settings load (their hooks run and their permission rules apply). `.mcp.json` stays ignored and git hooks stay disabled. Use it only for repositories whose settings you control.

## Permission mode

Sessions use `permissionMode: 'dontAsk'` with an explicit allow list (role built-ins and host MCP tools); anything else is denied by `canUseTool`.

`bypassPermissions` is never used: in that mode the sandbox's network prompts are approved automatically, so a domain outside the allow list was reachable in measurement.

A `PreToolUse` guard (fails closed) denies writes outside the worktree and direct `git push` / `gh` calls. Pushes and pull requests go through host tools.

## Tools and network

`AskUserQuestion`, `WebFetch` and `WebSearch` are always removed. Bash and file writes are only for worker roles that need them.

The sandbox is enabled with `failIfUnavailable: true` and `allowUnsandboxedCommands: false`. Network access is limited to `network.allow` (default empty).

macOS uses `sandbox-exec`. Linux needs `bubblewrap` and `socat` on PATH; the startup probe checks both. Container hosts may also need user namespaces.

With `policy.acceptMode: "auto"`, start is refused when the probe reports no sandbox, unless `security.allowUnsandboxed: true` is set.

Limits: `workers.maxTurns` and `workers.maxBudgetUsd`.

## Secrets

The session environment holds only PATH, HOME, LANG, USER, LOGNAME, SHELL, TMPDIR, the variables of the selected `auth.mode`, and a dedicated `CLAUDE_CONFIG_DIR` (auto memory off).

The hosting-service token and other daemon secrets never reach a session. Clone and fetch get their credentials only for that call.

## Admission and prompt injection

The allowlist decides whose events start work. It reads only authenticated event fields (logins are case-insensitive; bots are denied unless listed).

Content written by others that a session reads is a prompt injection risk, not an admission question. It is contained by the limits above, not by the allowlist.

## Subscription mode

A policy warning is printed at every start. Use is assumed to be personal.

An allowlist with people other than `auth.owner` needs `auth.acceptSubscriptionSharedUseRisk: true`, and it is logged with the risk warning. The OAuth token is read from the environment only.

## Not covered

No VM or gVisor isolation. The sandbox is the process-level sandbox of the agent runtime.

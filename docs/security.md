# Security and trust policy

Text from the hosting service is untrusted. The agent works in a git worktree per ticket, with tool, network and permission limits.

## Repository settings that run code

Sessions use `settingSources: []`: the repository's `.claude/settings.json` and `settings.local.json` hooks, permission rules and CLAUDE.md are not loaded. `.mcp.json` is ignored (`strictMcpConfig`); the only MCP server is the host-provided `superagent` server.

Git hooks: the clone's `core.hooksPath` points to an empty directory, re-set on every prepare, and every host git call passes `-c core.hooksPath=<empty dir>`, so `.husky` or any repository hook path does not run.

Opt-in `security.trustRepoConfig: true` sets `settingSources: ['project']`: the repository's project settings load (their hooks run and their permission rules apply). `.mcp.json` stays ignored and git hooks stay disabled. Use it only for repositories whose settings you control.

## Permission mode

Sessions use `permissionMode: 'dontAsk'` with an explicit allow list (role built-ins and host MCP tools); anything else is denied by `canUseTool`.

`bypassPermissions` is never used: in that mode the sandbox's network prompts are approved automatically, so a domain outside the allow list was reachable in measurement.

A `PreToolUse` guard (fails closed) denies writes outside the worktree and direct `git push` / `gh` calls. Pushes and pull requests go through host tools. Shell workers also have explicit allow rules for read-only git commands (show, log, diff, status, branch, blame, cat-file, ls-files, rev-parse); there is no broad git rule. Each guard denial is logged as a worker.tool_denied event with the tool and the reason, never the command text.

## Tools and network

`AskUserQuestion`, `WebFetch` and `WebSearch` are always removed. Bash and file writes are only for worker roles that need them.

The sandbox is enabled with `failIfUnavailable: true` and `allowUnsandboxedCommands: false`. Network access is limited to `network.allow` (default empty).

macOS uses `sandbox-exec`. Linux needs `bubblewrap` and `socat` on PATH; the startup probe runs bubblewrap once, the same way the sandbox will (with or without a fresh `/proc`). Container hosts may also need user namespaces.

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

## Containers

`security.weakerNestedSandbox` skips the fresh `/proc` mount inside the sandbox, so sandboxed commands share the container's `/proc` and can list the other processes.

- Risk: those processes (the init process, the agent and the Claude CLI) hold the agent's tokens in their environment. A bubblewrap layer alone, without the Claude CLI sandbox, could read them. Proxy measurement: 3 such processes with the default seccomp profile, 4 with it unconfined.
- Measured in the agent's own session: every other process's `/proc/<pid>/environ` failed to open with `Permission denied`. 0 processes were readable for the Claude credential name and 0 for the GitHub token name, and `/proc` stayed visible. The setup was Docker Desktop (kernel 6.10.14-linuxkit, aarch64) with the Claude CLI 0.3.321, with both the default and the unconfined seccomp profile.
- The agent also asks the sandbox to deny reads under `/proc`. In the measured Claude CLI version this did not hide `/proc`.
- It was not found which part of the Claude CLI sandbox denies these reads. Other Claude CLI versions, kernels or container runtimes, Kubernetes nodes included, may behave differently, so repeat the measurement there before you rely on it.
- `/proc/<pid>/mem`, `fd` and `maps` go through the same kernel access check as `environ`. This is inferred, not measured. Command lines (`/proc/<pid>/cmdline`) stay readable, and the agent does not put tokens on command lines.

On every platform, the file tools (`Read`, `Glob`, `Grep`) refuse paths under `/proc`. They run outside the command sandbox.

`seccomp=unconfined` and `apparmor=unconfined` (step 2 of the ladder in deploy.md) widen the container's kernel surface. Kubernetes Pod Security `baseline` and `restricted` reject an `Unconfined` seccomp profile, so such a pod needs a namespace at the `privileged` Pod Security level.

With `allowUnsandboxed`, the container is the only boundary, `network.allow` is not enforced, and commands can read the agent's tokens from other processes' environment (measured: 7 readable). Use it only with an egress policy, and only where the GitHub token's scope is acceptable to expose to the session.

## Not covered

No VM or gVisor isolation. The sandbox is the process-level sandbox of the agent runtime.

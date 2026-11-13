# Security and trust policy

Text from the hosting service is untrusted. The agent works in a git worktree per ticket, with tool, network and permission limits.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Repository settings that run code

Sessions use `settingSources: []`: the repository's `.claude/settings.json` and `settings.local.json` hooks, permission rules and CLAUDE.md are not loaded. `.mcp.json` is ignored (`strictMcpConfig`); the only MCP server is the host-provided `superagent` server.

Git hooks: the clone's `core.hooksPath` points to an empty directory, re-set on every prepare, and every host git call passes `-c core.hooksPath=<empty dir>`, so `.husky` or any repository hook path does not run.

Opt-in `security.trustRepoConfig: true` sets `settingSources: ['project']`: the repository's project settings load (their hooks run and their permission rules apply). `.mcp.json` stays ignored and git hooks stay disabled. Use it only for repositories whose settings you control.

## Permission mode

Sessions use `permissionMode: 'dontAsk'` with an explicit allow list (role built-ins and host MCP tools); `dontAsk` denies anything else without asking.

`bypassPermissions` is never used: in that mode the sandbox's network prompts are approved automatically, so a domain outside the allow list was reachable in measurement.

A `PreToolUse` guard (fails closed) denies writes outside the worktree and direct `git push` / `gh` calls. Pushes and pull requests go through host tools. Shell workers also have explicit allow rules for read-only git commands (show, log, diff, status, branch, blame, cat-file, ls-files, rev-parse); there is no broad git rule. Each guard denial is logged as a worker.tool_denied event with the tool and the reason, never the command text.

## Tools and network

`AskUserQuestion`, `WebFetch` and `WebSearch` are always removed. Bash and file writes are only for worker roles that need them.

The sandbox is enabled with `failIfUnavailable: true` and `allowUnsandboxedCommands: false`. Network access is limited to `network.allow` (default empty).

`security.allowLocalBinding` (default `true`) lets sandboxed commands bind and listen on local (loopback) ports, so tests that start an in-process server can run. It does not change outbound access, which stays limited to `network.allow`. A change needs a restart. Risk: on macOS it also lets sandboxed commands connect to services on the host's localhost, such as a local database or development server; set it to `false` on hosts that run such services. On Linux the sandbox has its own loopback, so the setting may have no effect there.

macOS uses `sandbox-exec`. Linux needs `bubblewrap` and `socat` on PATH; the startup probe runs bubblewrap once, the same way the sandbox will (with or without a fresh `/proc`). Container hosts may also need user namespaces.

With `policy.acceptMode: "auto"`, start is refused when the probe reports no sandbox, unless `security.allowUnsandboxed: true` is set.

Limits: `workers.maxTurns` and `workers.maxBudgetUsd`.

## Subagents

Only worker sessions may use the `Agent` tool; the router may not. Worker sessions get one custom subagent definition, `superagent-reviewer`; the router gets none.

A subagent runs inside the worker's CLI process: same environment (no extra variables or secrets), sandbox and network allow list, allow/deny lists, `dontAsk` mode and `PreToolUse` guard. It can never have more access than its worker.

Allowed types: subagent type omitted or one of `general-purpose`, `Explore`, `Plan`, `superagent-reviewer`; repository-defined agents (loadable with `security.trustRepoConfig`) are refused.

`isolation` is refused; a subagent cannot start another subagent.

Subagents cannot call host tools (`mcp__superagent__*`): status reports, human questions and publishing stay with the worker. The one exception is `mcp__superagent__git_inspect` for `superagent-reviewer`.

Inside a subagent the guard applies the same rules: no writes outside the worktree, no `git push` / `gh`, no `/proc` reads.

Subagents run in the foreground (`run_in_background: false` is forced), so they finish inside the worker's turn; their cost counts toward `workers.maxBudgetUsd`; `workers.maxTurns` counts only the worker's turns. A subagent's `model` / `effort` choice is not restricted; the worker's budget limit bounds it.

Guard denials inside a subagent are logged as `worker.tool_denied` with an `agentId` field; worker denials have no `agentId`.

### Pre-publish reviewer

When `orchestrator_publish` returns `review_required`, the worker may start `superagent-reviewer`. The guard admits that `Agent` call only while a host-decided review is pending, once per pending review, and the review counts from that moment.

Its tools are `Read`, `Glob`, `Grep` and `mcp__superagent__git_inspect`. Its definition also disallows `Bash`, `Write`, `Edit`, `NotebookEdit`, `Agent` and the web tools, and the `PreToolUse` guard denies every other tool for a call whose `agent_type` is `superagent-reviewer`. The denial is made in the hook, because tools on the worker's allow list are approved before any permission check.

The host puts a brief before its prompt: the original request, the human messages since, and the host diff (at most 60,000 characters, with a truncation marker), each as external data. Only the counts of its final `FINDINGS` line are logged, as `worker.review`.

`git_inspect` boundary: only `diff`, `log`, `show` and `blame`. Revisions and paths are validated and passed after `--end-of-options` and `--`. The host builds the argv and runs git without a shell, with no pager, no optional locks, `core.fsmonitor=false`, `--no-ext-diff --no-textconv --no-color`, against the ticket worktree's git directory, with no token in the environment, a 10 s timeout and an output cap of 64 KiB and a line limit. It cannot write, run external diff drivers or textconv filters. The worker can call it too.

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

## Next

- [runtime-contract.md](runtime-contract.md)

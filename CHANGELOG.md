# Changelog

All notable changes to this project are listed here. Entries are generated from Conventional Commits, versions follow Semantic Versioning, and before 1.0 breaking changes bump the MINOR version.

## [0.5.2] - 2026-11-13

- No user-facing changes.

## [0.5.1] - 2026-11-13

- No user-facing changes.

## [0.5.0] - 2026-11-13

### Features

- github: call the GitHub API through Octokit instead of the gh CLI (bf0f02a)

## [0.4.0] - 2026-11-13

### Features

- sandbox: allow local port binding by default with security.allowLocalBinding (be2e581)

### Fixes

- prompts: keep workers from asking for sandbox settings that do not exist (fae6043)

## [0.3.1] - 2026-11-13

### Fixes

- startup: drop charter rule numbers from refusal messages (4901978)

## [0.3.0] - 2026-11-13

### Features

- replies: post the reason when a ticket is blocked before work starts (0cd2bed)
- config: add per-repository branchFrom and pullRequestTo (d288bcf)

## [0.2.0] - 2026-11-12

### Features

- prompts: inject per-repository environment notes into worker instructions (f570879)
- review: add pre-publish review gate and read-only reviewer subagent (652a2d0)
- executor: add read-only git_inspect tool and review diff APIs (232abc8)

## [0.1.1] - 2026-11-12

### Fixes

- changelog: note releases with no user-facing changes (2f5be26)

## [0.1.0] - 2026-11-11

### Features

- add a tag-triggered release workflow and a releasing guide (2514ff1)
- add release and changelog scripts and package metadata for publishing (596be93)
- let the worker use built-in subagents under the same guard (6cf5d24)
- add contributing guide, issue and pull request templates and a secret-free CI workflow (6c0966a)
- add kubernetes manifest, health probes, graceful SIGTERM and JSON log format (a7bbccf)
- add container image with in-container sandbox support and block session reads of process environments (4404aa8)
- verify untrusted repository config and Linux sandbox, wire trustRepoConfig and split README into docs (a81cf2c)
- verify crash restart recovery at daemon level and harden startup, store locking and result delivery (16684a8)
- report blocked delivery on repositories without write access and drop fork option (0a689d3)
- add status/needs cli, worktree retention, readme and deploy docs (95269a7)
- add branch/pr delivery, review reply, auto-merge and pr close host tools (d0bc151)
- add live issue-to-reply e2e, session router github fake e2e and ingest/metering fixes (7bd7b76)
- add router session, host tools and master assessment (2c8f487)
- add git worktrees, session resume, prompt-version branching and claude runtime wiring (a6da37f)
- add config schema, auth modes, startup policy, admission filter and reload (20a0e2d)
- add claude agent sdk runtime adapter and worker tools over mcp (a5e6f2a)
- port prompts and skills with priority assembly, team sections and prompt versions (75fb722)
- add github polling source and comment channel for multiple repositories (0c6d0ab)
- add source framework, config, runtime composition and start --fake (61e9a55)
- add runtime contract, fake runtime and worker executor (e96a06e)
- port sqlite store, durable effects, passes and outbox (d45dc17)
- port policy gate with allowlist admission and injection tests (885d284)
- port core engine modules and engine tests (778d19e)
- port core model, ports and stage modules (d2b9145)
- add SDK semantics spike and findings report (347e5e9)
- scaffold superagent-claude package and repo hygiene checks (fc3d2fd)

### Fixes

- resolve symlinked paths before checking worker writes against the working directory (5977751)
- strip AI attribution from agent commits, pull requests and review replies (56dc39b)
- announce limit stops, keep finished tickets idle across restarts, hold acks until launch and reap orphaned sessions (6e44949)
- answer the real question in injected content, allow read-only git, flag missing write access up front and log guard denials (c8ed0f0)
- refresh ticket titles on steer, retry transient pushes and keep readable refusal reasons (ddd852a)
- decline mentioned out-of-scope requests, keep finished reports on limits and cap sessions by remaining budget (f705258)
- reply in the triggering thread, show idle sessions and link pull requests to their issue (70c3130)

## [0.1.0-rc.1] - 2026-11-11

### Features

- add a tag-triggered release workflow and a releasing guide (2514ff1)
- add release and changelog scripts and package metadata for publishing (596be93)
- let the worker use built-in subagents under the same guard (6cf5d24)
- add contributing guide, issue and pull request templates and a secret-free CI workflow (6c0966a)
- add kubernetes manifest, health probes, graceful SIGTERM and JSON log format (a7bbccf)
- add container image with in-container sandbox support and block session reads of process environments (4404aa8)
- verify untrusted repository config and Linux sandbox, wire trustRepoConfig and split README into docs (a81cf2c)
- verify crash restart recovery at daemon level and harden startup, store locking and result delivery (16684a8)
- report blocked delivery on repositories without write access and drop fork option (0a689d3)
- add status/needs cli, worktree retention, readme and deploy docs (95269a7)
- add branch/pr delivery, review reply, auto-merge and pr close host tools (d0bc151)
- add live issue-to-reply e2e, session router github fake e2e and ingest/metering fixes (7bd7b76)
- add router session, host tools and master assessment (2c8f487)
- add git worktrees, session resume, prompt-version branching and claude runtime wiring (a6da37f)
- add config schema, auth modes, startup policy, admission filter and reload (20a0e2d)
- add claude agent sdk runtime adapter and worker tools over mcp (a5e6f2a)
- port prompts and skills with priority assembly, team sections and prompt versions (75fb722)
- add github polling source and comment channel for multiple repositories (0c6d0ab)
- add source framework, config, runtime composition and start --fake (61e9a55)
- add runtime contract, fake runtime and worker executor (e96a06e)
- port sqlite store, durable effects, passes and outbox (d45dc17)
- port policy gate with allowlist admission and injection tests (885d284)
- port core engine modules and engine tests (778d19e)
- port core model, ports and stage modules (d2b9145)
- add SDK semantics spike and findings report (347e5e9)
- scaffold superagent-claude package and repo hygiene checks (fc3d2fd)

### Fixes

- resolve symlinked paths before checking worker writes against the working directory (5977751)
- strip AI attribution from agent commits, pull requests and review replies (56dc39b)
- announce limit stops, keep finished tickets idle across restarts, hold acks until launch and reap orphaned sessions (6e44949)
- answer the real question in injected content, allow read-only git, flag missing write access up front and log guard denials (c8ed0f0)
- refresh ticket titles on steer, retry transient pushes and keep readable refusal reasons (ddd852a)
- decline mentioned out-of-scope requests, keep finished reports on limits and cap sessions by remaining budget (f705258)
- reply in the triggering thread, show idle sessions and link pull requests to their issue (70c3130)

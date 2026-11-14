# Configuration

The config file `issuecrew.json` has 24 settings.

Required:

- `ISSUECREW_GITHUB_TOKEN` in the environment
- `repositories`
- `policy.allowed`

Everything else has a default.

`auth.mode` defaults to `api-key`. Whichever mode is used needs its Claude credential; see [authentication.md](authentication.md).

| Key | Default |
| --- | --- |
| `repositories` | required, one or more `owner/name` entries; an entry may be an object with branch settings (see [Repository branches](#repository-branches)) |
| `policy.allowed` | required, one or more logins |
| `policy.acceptMode` | `observe` |
| `policy.rules` | built-in rules |
| `policy.admission` | built-in table |
| `auth.mode` | `api-key` |
| `auth.owner` | unset |
| `auth.acceptSubscriptionSharedUseRisk` | `false` |
| `delivery.allowAutoMerge` | `false` |
| `workers.max` | `2` |
| `workers.maxTurns` | `100` |
| `workers.maxBudgetUsd` | `5` |
| `network.allow` | `[]` |
| `security.trustRepoConfig` | `false` |
| `security.allowUnsandboxed` | `false` |
| `security.weakerNestedSandbox` | `false` |
| `security.allowLocalBinding` | `true` |
| `retention.endedTicketDays` | `14` |
| `models.router` | unset |
| `models.worker` | unset |
| `review.enabled` | `true` |
| `review.minChangedLines` | `50` |
| `review.maxPerTicket` | `3` |
| `stateDir` | `~/.issuecrew` |

Allowed values:

- `workers.max`: an integer from 1 to 16
- `workers.maxTurns`, `retention.endedTicketDays`, `review.minChangedLines`, `review.maxPerTicket`: an integer, 1 or more
- `workers.maxBudgetUsd`: a number greater than 0
- `network.allow`: each entry 1 to 253 characters
- `policy.acceptMode`: `off`, `observe` or `auto`

A config with an unknown key, at any level, is rejected.

`security.weakerNestedSandbox` is for Linux containers that cannot mount a fresh `/proc`; see [deploy.md](deploy.md#sandbox-in-containers).

`security.allowLocalBinding` lets sandboxed commands bind and listen on local ports, so tests that start an in-process server can run. Outbound access stays limited to `network.allow`. A change needs a restart; see [security.md](security.md#tools-and-network) for the risk.

The default `policy.acceptMode` is `observe`. `auto` must be set explicitly.

- `off`: ignores every event and records nothing.
- `observe`: accepts nothing; records the events it would accept.
- `auto`: accepts the events the policy allows and starts work on them.

When a task stops at its turn or budget limit before it is done, the agent posts one comment that says which limit stopped it and links the pull request with the work so far, if there is one. A reply in that conversation continues the task with fresh limits. A finished task that is waiting for review keeps its result.

When a ticket is blocked before work starts, for example because a configured branch is missing, the agent comments the reason on the issue. Reply there once it is fixed to try the task again.

Pre-publish review: on each publish the host counts the lines changed (added plus deleted) since the last review, or on the whole branch when the ticket has had none. With `review.minChangedLines` or more, while the ticket has had fewer than `review.maxPerTicket` reviews, publish pushes nothing and returns `review_required`; the worker then runs the read-only `issuecrew-reviewer` subagent and publishes again. `review.enabled: false` turns this off. The `review` keys apply on reload, from the next publish.

A minimal config:

```json
{
  "repositories": ["owner/repo"],
  "policy": { "allowed": ["alice"] },
  "auth": { "mode": "api-key" }
}
```

See [security.md](security.md) for the trust policy behind the `security.*` and `network.allow` settings.

## Repository branches

An entry in `repositories` can be an object with branch settings. An entry that is only a string needs no settings:

```json
{
  "repositories": [
    "owner/tool",
    { "repository": "owner/app", "branchFrom": "main", "pullRequestTo": "dev" }
  ],
  "policy": { "allowed": ["alice"] }
}
```

- `branchFrom`: the remote branch a new worktree starts from; default the repository's default branch. `pullRequestTo`: the branch pull requests open against; default `branchFrom`, else the default branch. In the example, work starts from `main` and the pull request targets `dev`.
- Only the config file sets these; text in issues, comments or pull requests cannot change them.
- Each ticket keeps the values from when its worktree was created; after a reload (SIGHUP) new values apply to tickets started after it; the base of an open pull request is never changed.
- Not checked at startup. If a configured branch is missing on the remote when a ticket starts, or the target branch is missing at publish, the ticket is blocked, nothing is pushed and no pull request is opened; a person creates the branch or fixes the config.
- Warning: when the two differ, commits on `branchFrom` that are not on `pullRequestTo` show up in the pull request diff, and changes that exist only on `pullRequestTo` can conflict with the work.
- Names: letters, digits, `.`, `_`, `-`, `/`; no leading `-` or `/`, no `..` or `//`, no trailing `/` or `.lock`. A repository may be listed once.

## Environment notes

Each repository can have an environment note: a short text that tells the worker about the build and test environment, such as the installed toolchains, the commands that build and test the project, and known gaps.

- Path: `prompts/environment/<owner>/<name>.md` next to the config file, in the same `prompts/` directory as the team sections. For example, `prompts/environment/owner/repo.md`.
- Matching: directory and file names are compared with `repositories` case-insensitively, so `Owner/Repo.md` matches `owner/repo`.
- Size: at most 4000 characters after surrounding whitespace is trimmed. An empty note counts as no note.
- Scope: the note is added to the worker prompt only for tickets on that repository, after the team sections. It does not change the host rules. The router prompt never includes it.
- Errors: at startup, a note over 4000 characters or one that cannot be read stops the start with a config error that names the file. On reload, the same problem is logged as a warning and the previous note stays in effect.
- Unlisted repositories: a note for a repository that is not in `repositories` is ignored with a warning.
- Reload: a reload re-reads the notes. Open worker sessions on a repository whose note changed get the new note with their next input.
- Secrets: the worker reads the note as trusted text. Do not put tokens, passwords, or other secrets in a note.

## Next

- [authentication.md](authentication.md)

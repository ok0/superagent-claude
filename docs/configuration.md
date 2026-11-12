# Configuration

The config file `superagent-claude.json` has 23 settings.

Required:

- `auth.mode` and its Claude credential (see [authentication.md](authentication.md))
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
| `delivery.allowAutoMerge` | `false` |
| `workers.max` | `2` |
| `workers.maxTurns` | `100` |
| `workers.maxBudgetUsd` | `5` |
| `network.allow` | `[]` |
| `security.trustRepoConfig` | `false` |
| `security.allowUnsandboxed` | `false` |
| `security.weakerNestedSandbox` | `false` |
| `retention.endedTicketDays` | `14` |
| `models.router` | unset |
| `models.worker` | unset |
| `review.enabled` | `true` |
| `review.minChangedLines` | `50` |
| `review.maxPerTicket` | `3` |
| `stateDir` | `~/.superagent-claude` |

`security.weakerNestedSandbox` is for Linux containers that cannot mount a fresh `/proc`; see [deploy.md](deploy.md#sandbox-in-containers).

The default `policy.acceptMode` is `observe`. `auto` must be set explicitly.

When a task stops at its turn or budget limit before it is done, the agent posts one comment that says which limit stopped it and links the pull request with the work so far, if there is one. A reply in that conversation continues the task with fresh limits. A finished task that is waiting for review keeps its result.

Pre-publish review: on each publish the host counts the lines changed (added plus deleted) since the last review, or on the whole branch when the ticket has had none. With `review.minChangedLines` or more, while the ticket has had fewer than `review.maxPerTicket` reviews, publish pushes nothing and returns `review_required`; the worker then runs the read-only `superagent-reviewer` subagent and publishes again. `review.enabled: false` turns this off. The `review` keys apply on reload, from the next publish.

A minimal config:

```json
{
  "repositories": ["owner/repo"],
  "policy": { "allowed": ["alice"] },
  "auth": { "mode": "api-key" }
}
```

See [security.md](security.md) for the trust policy behind the `security.*` and `network.allow` settings.

## Next

- [authentication.md](authentication.md)

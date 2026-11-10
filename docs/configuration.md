# Configuration

The config file `superagent-claude.json` has 19 settings.

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
| `retention.endedTicketDays` | `14` |
| `models.router` | unset |
| `models.worker` | unset |
| `stateDir` | `~/.superagent-claude` |

The default `policy.acceptMode` is `observe`. `auto` must be set explicitly.

When a task stops at its turn or budget limit before it is done, the agent posts one comment that says which limit stopped it and links the pull request with the work so far, if there is one. A reply in that conversation continues the task with fresh limits. A finished task that is waiting for review keeps its result.

A minimal config:

```json
{
  "repositories": ["owner/repo"],
  "policy": { "allowed": ["alice"] },
  "auth": { "mode": "api-key" }
}
```

See [security.md](security.md) for the trust policy behind the `security.*` and `network.allow` settings.

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

A minimal config:

```json
{
  "repositories": ["owner/repo"],
  "policy": { "allowed": ["alice"] },
  "auth": { "mode": "api-key" }
}
```

See [security.md](security.md) for the trust policy behind the `security.*` and `network.allow` settings.

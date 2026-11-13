# Authentication

Set `auth.mode` to one of four values. Each needs the environment named in its section.

## api-key

Set `auth.mode` to `api-key`. Set `ANTHROPIC_API_KEY`.

## bedrock

Set `auth.mode` to `bedrock`. Set `AWS_REGION`, and either `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. `AWS_SESSION_TOKEN` is optional.

## vertex

Set `auth.mode` to `vertex`. Set `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, and Google application default credentials (`GOOGLE_APPLICATION_CREDENTIALS`).

## subscription

Set `auth.mode` to `subscription`. Set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

This mode runs the agent on a Claude subscription. Automated use is a gray area of the subscription terms, and superagent-claude prints a warning on every start.

Owner-only use means `auth.owner` is set and `policy.allowed` is exactly `[auth.owner]`. Any other allowlist is shared use. Shared use is a ToS risk, and superagent-claude refuses to start unless `auth.acceptSubscriptionSharedUseRisk` is `true`. The consent (its time and the allowed list hash) is logged and shown by `superagent-claude status`.

## Start refusals

superagent-claude refuses to start when:

- the credential for `auth.mode` is missing
- `policy.allowed` is empty
- `repositories` is empty
- the agent account's login is in `policy.allowed`
- the subscription is shared and no consent is given
- `auto` is set without a sandbox, unless `security.allowUnsandboxed` is set
- no repository is accessible
- `SUPERAGENT_CLAUDE_GITHUB_TOKEN` is missing
- the agent account cannot be read with `SUPERAGENT_CLAUDE_GITHUB_TOKEN`

## Next

- [deploy.md](deploy.md)

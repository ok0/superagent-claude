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

This mode runs the agent on a Claude subscription. Automated use is a gray area of the subscription terms, and issuecrew prints a warning on every start.

Owner-only use means `auth.owner` is set and `policy.allowed` is exactly `[auth.owner]`. Any other allowlist is shared use. Shared use is a ToS risk, and issuecrew refuses to start unless `auth.acceptSubscriptionSharedUseRisk` is `true`. The consent (its time and the allowed list hash) is logged and shown by `issuecrew status`.

## Start refusals

issuecrew refuses to start when:

- the credential for `auth.mode` is missing
- `policy.allowed` is empty
- `repositories` is empty
- the agent account's login is in `policy.allowed`
- the subscription is shared and no consent is given
- `auto` is set without a sandbox, unless `security.allowUnsandboxed` is set
- no repository is accessible
- `ISSUECREW_GITHUB_TOKEN` is missing
- the agent account cannot be read with `ISSUECREW_GITHUB_TOKEN`

## Next

- [deploy.md](deploy.md)

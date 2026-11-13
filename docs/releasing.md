# Releasing

This guide is for maintainers. A release publishes one version to four places: a git tag, the npm package `superagent-claude`, the container image `ghcr.io/ok0/superagent-claude` and a GitHub Release. You prepare the release on your machine. The release workflow (`.github/workflows/release.yml`) checks it and publishes it when you push the tag.

**Contents**

- [Versions](#versions)
- [One-time setup](#one-time-setup)
- [Prepare the release](#prepare-the-release)
- [Run the live tests](#run-the-live-tests)
- [Push to main and wait for CI](#push-to-main-and-wait-for-ci)
- [Tag and push](#tag-and-push)
- [What the release workflow does](#what-the-release-workflow-does)
- [Check the release](#check-the-release)
- [Recovery](#recovery)

## Versions

Versions follow Semantic Versioning (SemVer). Tags are `vMAJOR.MINOR.PATCH`, for example `v0.4.0`. The tag must match `version` in `package.json`.

- While the version is 0.x, a breaking change bumps MINOR, not MAJOR.
- A version with a hyphen suffix, such as `0.4.0-rc.1`, is a pre-release. It is published to npm under the `next` dist-tag and gets one image tag: the full version, `0.4.0-rc.1`.
- Any other version is a stable release. It is published to npm under `latest` and gets three image tags: `MAJOR.MINOR.PATCH`, `MAJOR.MINOR` and `latest`.

npm never accepts the same version number twice, even after an unpublish. If a published release is wrong, fix it and release the next version.

## One-time setup

The npm and GitHub menus below were checked in November 2026. The interface may change.

### npm trusted publisher

The workflow publishes to npm only with trusted publishing (OpenID Connect), with provenance. No npm token is stored in the repository, and the workflow reads no repository secrets. Requirements:

- npm CLI 11.5.1 or later. The workflow installs a fixed npm version that meets this.
- The repository is public, and `repository` in `package.json` points to it.
- The trusted publisher below is registered on the `superagent-claude` package. Before each release, check on the package settings page on npmjs.com that it is still there.

Register the trusted publisher:

1. Sign in to npmjs.com and open the `superagent-claude` package page.
2. Open **Settings**.
3. Under **Trusted Publisher**, choose **GitHub Actions**.
4. Organization or user: `ok0`.
5. Repository: `superagent-claude`.
6. Workflow filename: `release.yml` (the file name with its extension, no path).
7. Environment name: leave it empty.
8. Save the connection.

npm does not check these values when you save them. The connection is kept only if a publish through it succeeds within 2 days, so register it right before you push the tag.

### Container image visibility

The first push creates the `superagent-claude` package on ghcr.io as private. The image carries the label `org.opencontainers.image.source=https://github.com/ok0/superagent-claude`, which links the package to this repository.

1. Before you change the visibility, check the image: run `docker login ghcr.io` with your GitHub user name and a personal access token with `read:packages` as the password, then `docker pull ghcr.io/ok0/superagent-claude:<version>`.
2. On GitHub, open your profile → **Packages** → `superagent-claude` → **Package settings**.
3. Under **Danger Zone**, choose **Change visibility** → **Public** and confirm.

This is needed once. Later pushes keep the package public.

Optional: add a tag ruleset in the repository settings so that only maintainers can create `v*` tags.

## Prepare the release

1. Start from an up-to-date `main` with a clean working tree.
2. Run `pnpm release:prepare <version>`, for example `pnpm release:prepare 0.4.0`. It sets `version` in `package.json` and adds a section for that version at the top of `CHANGELOG.md`. It does not create a commit or a tag.
3. Review the new `CHANGELOG.md` section. It becomes the GitHub Release notes. You may edit the wording, but keep the `## [<version>] - <date>` heading.
4. Commit both files with the message `chore(release): <version>`.

## Run the live tests

Recommended, not enforced by the workflow: run `pnpm test:live` against your playground (see [Run live tests against your own playground](../CONTRIBUTING.md#run-live-tests-against-your-own-playground)) and keep a note of the result with the release.

## Push to main and wait for CI

1. Push the release commit: `git push origin main`.
2. Wait until the CI run for that commit succeeds, for example with `gh run list --workflow ci.yml --branch main --limit 1`. The release workflow refuses a commit whose CI run on `main` did not succeed.

## Tag and push

1. Create an annotated tag on the release commit: `git tag -a v<version> -m v<version>`.
2. Check that the trusted publisher is still registered (see [npm trusted publisher](#npm-trusted-publisher)). If you have to register it again, do it now.
3. Push the tag: `git push origin v<version>`.

Pushing a `v*` tag is the only thing that starts the release workflow.

## What the release workflow does

The workflow has four jobs. Each job starts only after the jobs before it succeed, in this order:

1. `verify` checks everything and publishes nothing: the tag matches `package.json`, the tagged commit is on `main`, CI succeeded for that commit (it waits up to 30 minutes for a CI run that is still going), `pnpm check:all` passes, the npm package contains only allowed files, the `CHANGELOG.md` section for the version is not empty, and the container image builds, runs as a non-root user and contains no secrets.
2. `npm` publishes the package with provenance under the dist-tag for the version, in the `publish (oidc)` step, then checks that the dist-tag points to the version. If the version is already on npm, it skips the publish and only checks the dist-tag.
3. `image` builds the image and pushes each image tag to `ghcr.io/ok0/superagent-claude`.
4. `release` creates the GitHub Release from the tag, with the `CHANGELOG.md` section as notes. A pre-release is marked as a pre-release and a stable release is marked as latest. If the Release already exists, it skips.

If `verify` fails, nothing is published anywhere. Fix the problem, delete the tag (`git push origin :refs/tags/v<version>` and `git tag -d v<version>`), and tag again.

## Check the release

- `npm view superagent-claude@<version> version` prints the version.
- `npm view superagent-claude dist-tags` shows `next` (pre-release) or `latest` (stable) at the version.
- `gh release view v<version>` shows the Release, marked as a pre-release or as latest.
- `docker pull ghcr.io/ok0/superagent-claude:<version>` works, and `docker image inspect --format '{{.Config.User}}' ghcr.io/ok0/superagent-claude:<version>` prints `10001:10001` (a non-root user).

## Recovery

- **Wrong dist-tag.** If the `verify dist-tag` step fails, fix the tag from your machine while logged in to npm: `npm dist-tag add superagent-claude@<version> <tag>`. The workflow does not change dist-tags itself.
- **The npm publish failed.** If `publish (oidc)` fails, for example because the trusted publisher is missing, nothing was published to npm and the later jobs did not run. The workflow has no other publish path. Fix the cause, then open the Actions run and choose **Re-run failed jobs**.
- **A later job failed.** If `npm` succeeded but `image` or `release` failed, the channels disagree until you fix it. Open the Actions run and choose **Re-run failed jobs**. Each publish step skips what is already published, so a re-run does not publish twice.
- **A wrong version was published.** npm does not accept the same version twice, so do not try to publish it again. Fix the problem and release the next patch version, for example `0.3.1`.

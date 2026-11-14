#!/usr/bin/env bash
# Runs the Linux sandbox check in a test-only container; refuses without live opt-in and a subscription token.
# Modes: default, seccomp, privileged (existing); weaker-nested (hardened + seccomp/apparmor unconfined + SANDBOX_WEAKER_NESTED=1),
# weaker-nested-default (hardened, default seccomp + SANDBOX_WEAKER_NESTED=1), unsandboxed (hardened + SANDBOX_ALLOW_UNSANDBOXED=1).
# The hardened modes keep --cap-drop ALL and --security-opt no-new-privileges.
# A placeholder ISSUECREW_GITHUB_TOKEN (not a token) lets the exposure count cover the GitHub token name; the real token is never passed.
set -euo pipefail

mode="${1:-default}"
if [ "${ISSUECREW_LIVE:-}" != "1" ] || [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "refused: set ISSUECREW_LIVE=1 and CLAUDE_CODE_OAUTH_TOKEN" >&2
  exit 2
fi

root=$(git rev-parse --show-toplevel)
out="$root/.docs/spikes/${SANDBOX_RUN_DIR:-linux-run}/$mode"
mkdir -p "$out"

hard=(--cap-drop ALL --security-opt no-new-privileges)
opts=()
envs=()
case "$mode" in
  default) ;;
  seccomp) opts=(--security-opt seccomp=unconfined --security-opt apparmor=unconfined) ;;
  privileged) opts=(--privileged) ;;
  weaker-nested) opts=("${hard[@]}" --security-opt seccomp=unconfined --security-opt apparmor=unconfined); envs=(-e SANDBOX_WEAKER_NESTED=1) ;;
  weaker-nested-default) opts=("${hard[@]}"); envs=(-e SANDBOX_WEAKER_NESTED=1) ;;
  unsandboxed) opts=("${hard[@]}"); envs=(-e SANDBOX_ALLOW_UNSANDBOXED=1) ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac

cd "$root"
git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do
  if [ -e "$f" ]; then printf '%s\0' "$f"; fi
done | tar --null -cf - -T - | docker build --platform linux/arm64 -t issuecrew-sandbox-check -f spikes/sandbox-linux/Dockerfile -

{
  docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'
  echo "options: ${opts[*]-none}"
  echo "env: ${envs[*]-none}"
} > "$out/env.txt"

docker run --rm --platform linux/arm64 ${opts[@]+"${opts[@]}"} ${envs[@]+"${envs[@]}"} -e CLAUDE_CODE_OAUTH_TOKEN -e ISSUECREW_GITHUB_TOKEN=sac-placeholder-not-a-token -e ISSUECREW_LIVE=1 -e SANDBOX_LINUX_OUT=/out -v "$out:/out" issuecrew-sandbox-check sh -c 'uname -a > /out/uname.txt; (command -v bwrap; command -v socat; bwrap --version; cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null; bwrap --ro-bind / / true && echo bwrap-ok; bwrap --ro-bind / / --dev /dev --unshare-all true && echo bwrap-noproc-ok; bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all true && echo bwrap-proc-ok; bwrap --ro-bind / / --dev /dev --tmpfs /proc --unshare-all true && echo bwrap-tmpfsproc-ok) > /out/tools.txt 2>&1; pnpm -s spike:sdk --only sandbox-secrets --out /out/spike.md > /out/spike.jsonl 2> /out/spike.stderr.txt; echo "spike exit=$?" > /out/exit.txt; pnpm -s test:live tests/live/sandbox-linux.spec.ts > /out/adapter.log 2>&1; echo "adapter exit=$?" >> /out/exit.txt' || true

for f in "$out"/*; do
  [ -f "$f" ] || continue
  if pnpm -s spike:sdk --scan "$f" >/dev/null 2>&1; then
    :
  else
    echo "leak: $f"
    exit 6
  fi
done
echo "clean"

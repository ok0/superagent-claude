#!/usr/bin/env bash
# Runs the Linux sandbox check in a test-only container; refuses without live opt-in and a subscription token.
set -euo pipefail

mode="${1:-default}"
if [ "${SUPERAGENT_CLAUDE_LIVE:-}" != "1" ] || [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "refused: set SUPERAGENT_CLAUDE_LIVE=1 and CLAUDE_CODE_OAUTH_TOKEN" >&2
  exit 2
fi

root=$(git rev-parse --show-toplevel)
out="$root/.docs/spikes/linux-run/$mode"
mkdir -p "$out"

opts=()
case "$mode" in
  default) ;;
  seccomp) opts=(--security-opt seccomp=unconfined --security-opt apparmor=unconfined) ;;
  privileged) opts=(--privileged) ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac

cd "$root"
git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do
  if [ -e "$f" ]; then printf '%s\0' "$f"; fi
done | tar --null -cf - -T - | docker build --platform linux/arm64 -t superagent-claude-sandbox-check -f spikes/sandbox-linux/Dockerfile -

{
  docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'
  echo "options: ${opts[*]-none}"
} > "$out/env.txt"

docker run --rm --platform linux/arm64 ${opts[@]+"${opts[@]}"} -e CLAUDE_CODE_OAUTH_TOKEN -e SUPERAGENT_CLAUDE_LIVE=1 -e SANDBOX_LINUX_OUT=/out -v "$out:/out" superagent-claude-sandbox-check sh -c 'uname -a > /out/uname.txt; (command -v bwrap; command -v socat; bwrap --version; cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null; bwrap --ro-bind / / true && echo bwrap-ok) > /out/tools.txt 2>&1; pnpm -s spike:sdk --only sandbox-secrets --out /out/spike.md > /out/spike.jsonl 2> /out/spike.stderr.txt; echo "spike exit=$?" > /out/exit.txt; pnpm -s test:live tests/live/sandbox-linux.spec.ts > /out/adapter.log 2>&1; echo "adapter exit=$?" >> /out/exit.txt' || true

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

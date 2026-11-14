#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/check-image-secrets.sh <image>" >&2
  exit 2
fi

image="$1"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
count=0

token_names=(anthropic-key github-token github-pat)
token_pats=(
  'sk-ant-(api|oat|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}'
  'gh[pousr]_[A-Za-z0-9]{36}'
  'github_pat_[A-Za-z0-9_]{60,}'
)
env_named='(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|ISSUECREW_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)='
env_generic='[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*='
literal_vars=(CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ISSUECREW_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN)
literal_hits=(0 0 0 0 0)
layer_hits=(0 0 0)

count_in() {
  grep -a -o -E -c -e "$1" "$2" || true
}

report() {
  if [ "$3" -gt 0 ]; then
    echo "found: $1 $2"
    count=$((count + $3))
  fi
}

scan_literals() {
  local f="$1" j name v n
  for j in "${!literal_vars[@]}"; do
    name=${literal_vars[j]}
    v="${!name-}"
    if [ "${#v}" -ge 8 ]; then
      n=$(grep -a -F -c -e "$v" "$f" || true)
      literal_hits[j]=$(( literal_hits[j] + n ))
    fi
  done
}

docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" > "$tmp/env.txt"
report inspect-env secret-env-name "$(count_in "^$env_named" "$tmp/env.txt")"
report inspect-env generic-secret-env-name "$(count_in "^$env_generic" "$tmp/env.txt")"

docker history --no-trunc --format '{{.CreatedBy}}' "$image" > "$tmp/history.txt"
grep -a -E '(ENV|ARG) ' "$tmp/history.txt" > "$tmp/history-env.txt" || true
report history secret-env-name "$(count_in "$env_named" "$tmp/history-env.txt")"
report history generic-secret-env-name "$(count_in "$env_generic" "$tmp/history-env.txt")"
for i in "${!token_pats[@]}"; do
  report history "${token_names[$i]}" "$(count_in "${token_pats[$i]}" "$tmp/history.txt")"
done

docker save "$image" -o "$tmp/image.tar"
mkdir "$tmp/x"
tar -xf "$tmp/image.tar" -C "$tmp/x"

scan_literals "$tmp/env.txt"
scan_literals "$tmp/history.txt"

while IFS= read -r f; do
  { tar -xOf "$f" 2>/dev/null || cat "$f"; } > "$tmp/stream"
  for i in "${!token_pats[@]}"; do
    layer_hits[i]=$(( layer_hits[i] + $(count_in "${token_pats[$i]}" "$tmp/stream") ))
  done
  scan_literals "$tmp/stream"
done < <(find "$tmp/x" -type f)

for i in "${!token_pats[@]}"; do
  report layer "${token_names[$i]}" "${layer_hits[$i]}"
done
for j in "${!literal_vars[@]}"; do
  report literal "${literal_vars[$j]}" "${literal_hits[$j]}"
done

echo "secrets: $count"
if [ "$count" -eq 0 ]; then
  exit 0
fi
exit 1

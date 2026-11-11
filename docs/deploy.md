# Deploy

**Contents**

- [Service setup](#service-setup)
- [Docker](#docker)
- [Sandbox in containers](#sandbox-in-containers)
- [Kubernetes](#kubernetes)
  - [One replica](#one-replica)
  - [Probes and stopping](#probes-and-stopping)
  - [JSON logs](#json-logs)
  - [Sandbox on Kubernetes](#sandbox-on-kubernetes)

## Service setup

To run superagent-claude as a service, run `superagent-claude start` in the foreground under a service manager. On SIGTERM it cleans up for at most 10 seconds and exits with code 0 within 15 seconds, and SIGHUP reloads the config. Keep the secrets in an env file that only the service user can read, with `chmod 600`.

Env file `~/.config/superagent-claude/env`:

```sh
SUPERAGENT_CLAUDE_GITHUB_TOKEN=<agent account token>
ANTHROPIC_API_KEY=<API key>
```

systemd unit `/etc/systemd/system/superagent-claude.service`:

```ini
[Unit]
Description=superagent-claude
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent
EnvironmentFile=/home/agent/.config/superagent-claude/env
ExecStart=/usr/bin/superagent-claude start --config /home/agent/superagent-claude/superagent-claude.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

Enable and start it with `systemctl enable --now superagent-claude`.

launchd plist `~/Library/LaunchAgents/dev.superagent-claude.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.superagent-claude</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>set -a; . "$HOME/.config/superagent-claude/env"; exec /usr/local/bin/superagent-claude start --config "$HOME/superagent-claude/superagent-claude.json"</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/<user>/Library/Logs/superagent-claude.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/<user>/Library/Logs/superagent-claude.err.log</string>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/dev.superagent-claude.plist`.

## Docker

Build the image locally. No image is published.

```sh
docker build -t superagent-claude:local .
```

The image runs as uid 10001 with tini as PID 1, so `docker stop` sends SIGTERM to the service.

State lives in the volume `/var/lib/superagent-claude`. The default `stateDir` resolves to `/var/lib/superagent-claude/.superagent-claude` because `HOME` points there.

The config is mounted read-only at `/etc/superagent-claude/superagent-claude.json`. Secrets come only from `--env-file` (the env file above) or `-e NAME`, and are never written into the image.

Recommended run, with the hardened flags of the first step of the sandbox ladder below:

```sh
docker run -d --name superagent-claude \
  --cap-drop ALL --security-opt no-new-privileges \
  --env-file "$HOME/.config/superagent-claude/env" \
  -v superagent-claude-state:/var/lib/superagent-claude \
  -v "$HOME/superagent-claude/superagent-claude.json:/etc/superagent-claude/superagent-claude.json:ro" \
  superagent-claude:local
```

## Sandbox in containers

The agent's command sandbox uses bubblewrap. Inside a container it may not be able to mount a fresh `/proc`, and then the start is refused. The steps below go in order; stop at the first one that starts.

What was measured: Docker 27.4.0 on the Docker Desktop VM (kernel 6.10.14-linuxkit, aarch64). Results on Linux hosts, Kubernetes nodes and other kernels can differ, so repeat the check on the target before you rely on it.

1. Hardened flags and `weakerNestedSandbox`. Set this in the config:

   ```json
   "security": { "weakerNestedSandbox": true }
   ```

   Run with `--cap-drop ALL --security-opt no-new-privileges` (the example above). In this mode commands share the container's `/proc`. In the measured setup they could not read other processes' environment, but this depends on the Claude CLI version and the kernel, so see [security.md](security.md#containers) before you rely on it there.
2. Add `--security-opt seccomp=unconfined --security-opt apparmor=unconfined` to the `docker run` command. This widens the container's kernel surface. A Kubernetes pod with this profile needs a namespace at the `privileged` Pod Security level.
3. Set `security.allowUnsandboxed: true` and restrict egress with a network policy. The start then prints a warning, and commands run without the sandbox. See [security.md](security.md#containers).

If the start is refused, the message is:

```text
Startup refused (rule 7, unsandboxed): policy.acceptMode auto needs the runtime sandbox, which is unavailable here; set security.allowUnsandboxed to true to run without it; see docs/deploy.md#sandbox-in-containers
```

Running the container with full host privileges is not recommended.

## Kubernetes

`deploy/k8s/superagent-claude.yaml` runs the image as one pod. It sets no namespace, so apply it to the namespace you choose. Make the image available to the cluster yourself, for example with `kind load docker-image superagent-claude:local`. With a registry, replace `superagent-claude:local` with `<registry>/superagent-claude:<tag>`. No image is published.

```yaml
# superagent-claude on Kubernetes: one replica, state on a ReadWriteOnce volume.
# The Secret below holds empty placeholders only; set the values with kubectl create secret (docs/deploy.md).
apiVersion: v1
kind: ConfigMap
metadata:
  name: superagent-claude
  labels:
    app.kubernetes.io/name: superagent-claude
data:
  superagent-claude.json: |
    {
      "repositories": ["<owner>/<repository>"],
      "policy": { "allowed": ["<github-login>"] },
      "security": { "weakerNestedSandbox": true }
    }
---
apiVersion: v1
kind: Secret
metadata:
  name: superagent-claude
  labels:
    app.kubernetes.io/name: superagent-claude
    app.kubernetes.io/component: credentials
type: Opaque
stringData:
  SUPERAGENT_CLAUDE_GITHUB_TOKEN: ""
  ANTHROPIC_API_KEY: ""
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: superagent-claude-state
  labels:
    app.kubernetes.io/name: superagent-claude
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: superagent-claude
  labels:
    app.kubernetes.io/name: superagent-claude
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: superagent-claude
  template:
    metadata:
      labels:
        app.kubernetes.io/name: superagent-claude
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: superagent-claude
          image: superagent-claude:local
          imagePullPolicy: IfNotPresent
          args: ["start", "--config", "/etc/superagent-claude/superagent-claude.json", "--log-format", "json"]
          envFrom:
            - secretRef:
                name: superagent-claude
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          readinessProbe:
            exec:
              command: ["superagent-claude", "health", "--ready", "--config", "/etc/superagent-claude/superagent-claude.json"]
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          livenessProbe:
            exec:
              command: ["superagent-claude", "health", "--live", "--config", "/etc/superagent-claude/superagent-claude.json"]
            initialDelaySeconds: 30
            periodSeconds: 20
            timeoutSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
          volumeMounts:
            - name: state
              mountPath: /var/lib/superagent-claude
            - name: config
              mountPath: /etc/superagent-claude
              readOnly: true
      volumes:
        - name: state
          persistentVolumeClaim:
            claimName: superagent-claude-state
        - name: config
          configMap:
            name: superagent-claude
```

1. Replace the placeholders in the ConfigMap's `superagent-claude.json` (`repositories`, `policy.allowed`). The pod does not start with the placeholder values.
2. Apply the file: `kubectl apply -f deploy/k8s/superagent-claude.yaml`.
3. Set the secrets from the env file at the top of this page, then restart the pod:

   ```sh
   kubectl create secret generic superagent-claude \
     --from-env-file="$HOME/.config/superagent-claude/env" \
     --dry-run=client -o yaml | kubectl apply -f -
   kubectl rollout restart deployment/superagent-claude
   ```

   The Secret in the file has empty values only, so applying the whole file again empties it. Apply later changes without it: `kubectl apply -f deploy/k8s/superagent-claude.yaml -l 'app.kubernetes.io/component!=credentials'`. For another `auth.mode`, put that mode's variables in the env file instead of `ANTHROPIC_API_KEY`.

### One replica

The state (the SQLite database and the worktrees) lives on the `ReadWriteOnce` volume at `/var/lib/superagent-claude`, and only one process may write it. `replicas: 1` and `strategy: Recreate` stop the old pod before the new one starts. Do not scale it up: a second pod never becomes ready. On another node it cannot mount the volume. On the same node it finds the state lock held and exits with code 2. After a forced kill, a new pod can wait up to 30 seconds for the old lock to expire.

### Probes and stopping

Both probes run `superagent-claude health`, which exits 0 when the check passes and 1 when it fails (2 for bad arguments). `superagent-claude health --ready` passes once the daemon has opened its state, loaded the config and finished recovery. `superagent-claude health --live` passes while the process holding the state lock runs and its health snapshot is less than 60 seconds old, so a stopped or hung process fails it.

On SIGTERM the daemon fails readiness at once, stops taking new work and records running work as interrupted. It then cleans up for at most 10 seconds and exits with code 0 within 15 seconds, inside `terminationGracePeriodSeconds: 30`. The next start resumes the interrupted work, and replies that were already posted are not posted again. If the grace period runs out, Kubernetes kills the process, and the next start recovers in the same way.

### JSON logs

`--log-format json`, or the env variable `SUPERAGENT_CLAUDE_LOG_FORMAT=json`, writes every line as one JSON event on stdout, warnings included, and nothing on stderr. The default `text` keeps the JSON events on stdout and plain-text warnings on stderr. In both formats, secret values and token shapes are replaced with `[redacted]`.

### Sandbox on Kubernetes

The pod runs as uid 10001 with every capability dropped, no privilege escalation and the `RuntimeDefault` seccomp profile, which the Pod Security `baseline` and `restricted` levels allow. The config sets `security.weakerNestedSandbox: true` (see [Sandbox in containers](#sandbox-in-containers)). This setup was measured with Docker's default seccomp profile, not on Kubernetes nodes. A node's seccomp or AppArmor defaults can still block the sandbox. With `policy.acceptMode` `auto`, the start is then refused with the rule 7 message above and the pod restarts. Ways out, in order:

1. Give the pod `Localhost` seccomp and AppArmor profiles that allow user namespaces, installed on the nodes. Pod Security `baseline` allows `Localhost` profiles.
2. Set `security.allowUnsandboxed: true` and restrict egress with a NetworkPolicy. Commands then run without the sandbox; see [security.md](security.md#containers).

An `Unconfined` seccomp or AppArmor profile is rejected at `baseline` and `restricted`. It needs a namespace at the `privileged` Pod Security level or an exemption from Pod Security admission. The manifest does not use it, and it is not recommended.

## Next

- [security.md](security.md)

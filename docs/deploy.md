# Deploy

To run superagent-claude as a service, run `superagent-claude start` in the foreground under a service manager. SIGTERM stops it within 10 seconds, and SIGHUP reloads the config. Keep the secrets in an env file that only the service user can read, with `chmod 600`.

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

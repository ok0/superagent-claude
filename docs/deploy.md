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

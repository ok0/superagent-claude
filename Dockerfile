# superagent-claude image. No secrets are built in; credentials come from the environment at run time.
FROM node:24-bookworm-slim AS build
ENV CI=true
RUN npm install -g pnpm@11.28.11
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN pnpm build && rm -rf node_modules && pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh bubblewrap socat ripgrep ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 superagent \
 && useradd --uid 10001 --gid 10001 --home-dir /var/lib/superagent-claude --no-create-home --shell /usr/sbin/nologin superagent \
 && mkdir -p /var/lib/superagent-claude /etc/superagent-claude \
 && chown 10001:10001 /var/lib/superagent-claude
WORKDIR /opt/superagent-claude
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/lib ./lib
COPY prompts ./prompts
COPY skills ./skills
COPY LICENSE NOTICE README.md ./
RUN ln -s /opt/superagent-claude/lib/cli.js /usr/local/bin/superagent-claude
ENV HOME=/var/lib/superagent-claude NODE_ENV=production
USER 10001:10001
WORKDIR /var/lib/superagent-claude
VOLUME /var/lib/superagent-claude
ENTRYPOINT ["/usr/bin/tini", "--", "superagent-claude"]
CMD ["start", "--config", "/etc/superagent-claude/superagent-claude.json"]

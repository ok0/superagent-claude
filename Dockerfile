# issuecrew image. No secrets are built in; credentials come from the environment at run time.
FROM node:24-bookworm-slim AS build
ENV CI=true
RUN npm install -g pnpm@11.28.11
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN pnpm build && rm -rf node_modules && pnpm install --frozen-lockfile --prod && find node_modules -type f \( -iname 'readme*' -o -iname 'changelog*' -o -iname 'history*.md' \) -delete

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bubblewrap socat ripgrep ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 issuecrew \
 && useradd --uid 10001 --gid 10001 --home-dir /var/lib/issuecrew --no-create-home --shell /usr/sbin/nologin issuecrew \
 && mkdir -p /var/lib/issuecrew /etc/issuecrew \
 && chown 10001:10001 /var/lib/issuecrew
WORKDIR /opt/issuecrew
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/lib ./lib
COPY prompts ./prompts
COPY skills ./skills
COPY LICENSE NOTICE README.md ./
RUN ln -s /opt/issuecrew/lib/cli.js /usr/local/bin/issuecrew
ENV HOME=/var/lib/issuecrew NODE_ENV=production
USER 10001:10001
WORKDIR /var/lib/issuecrew
VOLUME /var/lib/issuecrew
ENTRYPOINT ["/usr/bin/tini", "--", "issuecrew"]
CMD ["start", "--config", "/etc/issuecrew/issuecrew.json"]

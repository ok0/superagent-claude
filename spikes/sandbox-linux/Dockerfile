# Test-only image for the Linux sandbox check; no secrets are built in.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat git curl ca-certificates ripgrep procps && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.28.11
RUN mkdir /work && chown node:node /work
WORKDIR /work
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile
RUN git init -q && git add -A && git -c user.name=snapshot -c user.email=snapshot@example.invalid -c commit.gpgsign=false commit -q -m "chore: snapshot"

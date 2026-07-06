# syntax=docker/dockerfile:1
# Generic dev image for GrowthOS background workers. Runs a single worker
# package selected via the compose `command`. Uses a non-frozen install so
# newly-added workspace packages resolve without a host lockfile update.
FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.17.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --prefer-offline || pnpm install

CMD ["pnpm", "--filter", "@growthos/worker-paperclip-heartbeat", "start"]

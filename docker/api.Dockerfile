# syntax=docker/dockerfile:1
# Production bundle via `pnpm deploy` (avoids copying the full pnpm virtual store).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.17.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm turbo run build --filter=@growthos/api
RUN pnpm --filter @growthos/api deploy --prod /deploy

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app
COPY --from=build /deploy/ /app/
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]

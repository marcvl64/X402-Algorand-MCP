# Multi-stage build: compile with dev dependencies, ship without them.
#
# The runtime image installs production dependencies only, so vitest — and
# therefore esbuild and its native binary — never reach the deployed image.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- build -----------------------------------------------------------------
FROM base AS build

# Copy manifests first so dependency layers cache independently of source.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# --- production dependencies -----------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV PORT=3000

# Run unprivileged. The node image ships a `node` user for exactly this.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Fly Machines supply an init that reaps and forwards signals, so Node can be
# PID 1 here. The server already handles SIGINT/SIGTERM for graceful shutdown.
CMD ["node", "dist/index.js"]

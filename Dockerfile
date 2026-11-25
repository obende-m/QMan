# The API, containerised.
#
# Only Fly.io needs this — Render, Railway and Vercel build from source. It is
# kept at the repository root rather than in apps/api because the build needs
# the whole workspace: the API imports @qman/domain and @qman/persistence as
# workspace packages, and a context of apps/api alone cannot see them.
#
# Two stages. The builder installs every dependency including TypeScript and
# compiles; the runtime keeps only what the server needs. A single-stage image
# would ship the compiler and the source to production for no reason.

FROM node:20-slim AS builder
WORKDIR /app

# Manifests first, so a change to source code does not invalidate the install
# layer. The workspace packages each need their manifest present before
# `npm ci` will link them.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/persistence/package.json packages/persistence/
COPY apps/api/package.json apps/api/

# The full install, TypeScript included. Pruning dev dependencies here would
# remove the compiler before it has run.
RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

# Project references build @qman/domain and @qman/persistence first.
RUN npm run build -w @qman/api

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runtime dependencies only. The compiler and the test tooling stay behind.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/persistence/package.json packages/persistence/
COPY apps/api/package.json apps/api/
RUN npm ci --workspaces --include-workspace-root --omit=dev && npm cache clean --force

COPY --from=builder /app/packages/domain/dist packages/domain/dist
COPY --from=builder /app/packages/persistence/dist packages/persistence/dist
COPY --from=builder /app/apps/api/dist apps/api/dist

# The migrations are read from disk at runtime, not compiled in:
# `migrationsDirectory()` resolves @qman/persistence/package.json and reads the
# sibling `migrations` directory. Omitting this copy produces a container that
# starts and then fails to migrate.
COPY packages/persistence/migrations packages/persistence/migrations

# Not root. A compromised process should not own the filesystem it runs on.
USER node

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]

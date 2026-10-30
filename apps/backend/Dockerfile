FROM node:24-alpine AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN pnpm install --frozen-lockfile

COPY apps/backend apps/backend
RUN pnpm --filter @invoiceops/backend build
RUN pnpm deploy --legacy --filter @invoiceops/backend --prod /runtime

# One-shot tooling image (`--target tooling`): the full workspace with dev
# dependencies, so the Prisma CLI can apply migrations. It needs only
# DATABASE_URL and runs the binary directly (`pnpm exec` would try to reinstall
# modules). Never run as a long-lived service.
FROM build AS tooling

WORKDIR /workspace/apps/backend
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

FROM node:24-alpine AS runtime

WORKDIR /workspace/apps/backend
ENV NODE_ENV=production

COPY --from=build /runtime ./

ENV PORT=3000
# Listen on every interface inside the container; compose publishes the port
# on loopback only.
ENV HOST=0.0.0.0
EXPOSE 3000
# The process only reads its own files and talks to PostgreSQL; it needs no
# root privileges and writes nothing to disk.
USER node
CMD ["node", "dist/server.js"]

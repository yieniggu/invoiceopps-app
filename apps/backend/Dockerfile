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

FROM node:24-alpine

WORKDIR /workspace/apps/backend
ENV NODE_ENV=production

COPY --from=build /runtime ./

EXPOSE 3000
CMD ["node", "dist/server.js"]

# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/auth/package.json packages/auth/
COPY packages/database/package.json packages/database/
COPY packages/logger/package.json packages/logger/
COPY packages/shared/package.json packages/shared/
COPY packages/workflow-engine/package.json packages/workflow-engine/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile
RUN pnpm --filter @gdms/shared build && pnpm --filter @gdms/auth build && pnpm --filter @gdms/logger build && pnpm --filter @gdms/workflow-engine build
RUN pnpm --filter @gdms/database exec prisma generate && pnpm --filter @gdms/database build
RUN pnpm --filter @gdms/api build

FROM base AS runner
ENV NODE_ENV=production
ENV UPLOADS_DIR=/repo/apps/api/uploads
WORKDIR /repo
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api ./apps/api
COPY --from=build /repo/node_modules ./node_modules
RUN mkdir -p /repo/apps/api/uploads/avatars
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]

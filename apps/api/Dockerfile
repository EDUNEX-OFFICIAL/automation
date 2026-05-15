FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @gdms/shared build && pnpm --filter @gdms/auth build && pnpm --filter @gdms/logger build && pnpm --filter @gdms/workflow-engine build
RUN pnpm --filter @gdms/database exec prisma generate && pnpm --filter @gdms/database build
RUN pnpm --filter @gdms/api build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/api ./apps/api
COPY --from=build /repo/node_modules ./node_modules
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]

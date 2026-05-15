FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps/ai-service ./apps/ai-service
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @gdms/shared build
RUN pnpm --filter @gdms/database exec prisma generate && pnpm --filter @gdms/database build
RUN pnpm --filter @gdms/ai-service build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/ai-service ./apps/ai-service
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
WORKDIR /repo/apps/ai-service
EXPOSE 4200
CMD ["node", "dist/server.js"]

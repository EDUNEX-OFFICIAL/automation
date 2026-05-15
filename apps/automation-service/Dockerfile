FROM mcr.microsoft.com/playwright:v1.49.1-jammy
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps/automation-service ./apps/automation-service
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @gdms/shared build && pnpm --filter @gdms/workflow-engine build
RUN pnpm --filter @gdms/database exec prisma generate && pnpm --filter @gdms/database build
RUN pnpm --filter @gdms/automation-service build

ENV NODE_ENV=production
WORKDIR /repo/apps/automation-service
EXPOSE 4101
CMD ["node", "dist/server.js"]

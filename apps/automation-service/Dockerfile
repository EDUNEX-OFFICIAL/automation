FROM mcr.microsoft.com/playwright:v1.49.1-jammy
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify python3-websockify fluxbox \
  && ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages ./packages
COPY apps/automation-service ./apps/automation-service
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @gdms/shared build && pnpm --filter @gdms/workflow-engine build
RUN pnpm --filter @gdms/database exec prisma generate && pnpm --filter @gdms/database build
RUN pnpm --filter @gdms/automation-service build
RUN pnpm --filter @gdms/automation-service exec playwright install chromium

ENV NODE_ENV=production
ENV PLAYWRIGHT_HEADED=true
ENV DISPLAY=:99
WORKDIR /repo/apps/automation-service
RUN chmod +x docker-entrypoint.sh
EXPOSE 4101 6080 6081
ENTRYPOINT ["./docker-entrypoint.sh"]

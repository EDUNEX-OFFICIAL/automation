# GDMS Automation SaaS (MVP Monorepo)

**Stack:** pnpm + Turborepo, Next.js (dashboard), Fastify + Socket.IO (API), Prisma + Postgres, Redis + BullMQ, Playwright automation service, AI service stub (Ollama + optional whisper/XTTS/RVC paths), Kotlin Android gateway.

## Phase 2 (done in repo)

- **Device Socket.IO auth**: `deviceId` + `socketToken` (bcrypt hashed in DB; plain token only in the `/claim` response).
- **Click-to-call → phone**: not `GET` — after `POST /v1/inquiries/:id/call`, emit `CALL_TASK` to the device room.
- **Prisma migration**: `packages/database/prisma/migrations/20260214120000_phase2_android_socket_token`.
- **Android**: `io.socket:socket.io-client` + claim → service with `socketToken`.

## Phase 3 (done in repo)

- **Call status pipeline**: Android `PhoneStateListener` → `POST /v1/android/call-status` (device auth) → `CallLog` rows + `AiCall.lastCallPhase` / `callEndedAt` → Socket.IO `CALL_STATUS_UPDATE` to `dealer:{id}` (Leads page shows live phase).
- **Token rotation**: `POST /v1/android/rotate-socket-token` with current token → new `socketToken` (reconnect app with fresh token).
- **Prisma migration**: `packages/database/prisma/migrations/20260215103000_phase3_call_status`.
- **CI**: `.github/workflows/ci.yml` — `pnpm turbo run build` on push/PR (Typecheck across workspace).

## Phase 4 (done in repo)

- **SUPER_ADMIN realtime**: on Socket.IO connect, joins every `dealer:{id}` room so workflow + `CALL_STATUS_UPDATE` + lead events fire without extra emits.
- **Leads API**: `GET /v1/inquiries` without `dealerId` (SUPER_ADMIN only) returns latest 300 inquiries across tenants with `dealerName`; with `?dealerId=` still scoped + RBAC.
- **Dashboard**: Leads page — super admin dealer filter (`All` / one dealer); `LEAD_CLASSIFIED` refetch uses the same query as the table (via `inquiriesQuerySuffix` in store).
- **Caveat**: after a new dealer is created, the super admin only joins the new dealer rooms after reconnecting the socket (page refresh / re-login).

## Phase 5 (done in repo — foundation)

- **Android**: `GatewayCredentials` — `androidx.security:security-crypto` EncryptedSharedPreferences for `apiBase` + `deviceId` + `socketToken` after claim; **Start gateway (saved token)** and **Clear saved credentials**; app version **0.4.0**.
- **Shared contract**: Socket.IO `VOICE_SESSION_SIGNAL` + `VoiceSessionSignalPayload` — no relay yet; names fixed for future WebRTC/SFU.
- **API env**: `VOICE_BRIDGE_ENABLED=true|false` — startup log only; TURN/SFU is a separate milestone.

**Token rotate / new API `socketToken`:** the app does not auto-update prefs yet — **pair** again or Clear + Pair; later you can update prefs from the rotate REST endpoint.

## Phase 6 (done in repo — WebRTC prep + hardening scaffold)

- **API**: `GET /v1/integrations/webrtc` (JWT) → `{ voiceBridgeEnabled, iceServers }` — default STUN via `WEBRTC_STUN_URLS`; optional TURN: `WEBRTC_TURN_URLS` + `WEBRTC_TURN_USERNAME` + `WEBRTC_TURN_PASSWORD`.
- **Android** `0.5.0`: **BiometricPrompt** before **Start gateway (saved token)**; devices without enrolled biometrics fall back to starting without unlock (toast).
- **`network_security_config`**: cleartext + system/user CAs for dev; commented **pin-set** example for production.

## Phase 7 (next ideas)

- SFU: mediasoup / LiveKit; relay `VOICE_SESSION_SIGNAL` + media path.
- PSTN recording / compliance retention policies.

Next milestones: browser `RTCPeerConnection` + prod TURN + Socket signalling relay.

## Quick start (local)

1. Install **Node 20+**, **pnpm 9**, **Docker Desktop** (Postgres + Redis).
2. Copy env files:
   - Root: create `.env` from snippets below (or use `docker-compose` env).
3. Generate **32-byte base64** credential key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

4. `pnpm install`
5. `pnpm --filter @gdms/shared build` && `pnpm --filter @gdms/auth build` && `pnpm --filter @gdms/logger build` && `pnpm --filter @gdms/workflow-engine build` && `pnpm --filter @gdms/database exec prisma generate`
6. Start Postgres/Redis: `pnpm docker:up` (or `docker compose up -d postgres redis`). Compose maps **Postgres → localhost:54322** and **Redis → localhost:6380** on the host — set `DATABASE_URL` / `REDIS_URL` in each app `.env` to those ports when Node runs on your machine.
7. `pnpm --filter @gdms/database exec prisma db push`
8. Dev (separate terminals):  
   - `pnpm --filter @gdms/api dev`  
   - `pnpm --filter @gdms/worker dev`  
   - `pnpm --filter @gdms/automation-service dev` (set `GDMS_BASE_URL`)  
   - `pnpm --filter @gdms/ai-service dev`  
   - `pnpm --filter web dev`

9. Open `http://localhost:3000`, register first user (bootstrap), create dealer, save GDMS credentials in Settings, then **START** automation from Dashboard.

## Environment (essentials)

**API (`apps/api`)**  
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (32+ chars), `REFRESH_TOKEN_SECRET`, `CREDENTIALS_MASTER_KEY` (base64 32 bytes), `CORS_ORIGIN=http://localhost:3000`, optional `VOICE_BRIDGE_ENABLED=true`, optional `WEBRTC_STUN_URLS` (comma-separated), optional TURN triple `WEBRTC_TURN_URLS` + `WEBRTC_TURN_USERNAME` + `WEBRTC_TURN_PASSWORD`

**Worker (`apps/worker`)**  
Same DB/Redis + `CREDENTIALS_MASTER_KEY`, `AUTOMATION_INTERNAL_SECRET`, `AI_INTERNAL_SECRET`, optional `GDMS_BASE_URL`, `GDMS_INQUIRY_LIST_URL`

**Automation (`apps/automation-service`)**  
`DATABASE_URL`, `REDIS_URL`, `GDMS_BASE_URL`, `SESSIONS_DIR`, `AUTOMATION_INTERNAL_SECRET`, optional `PLAYWRIGHT_HEADED=true`

**AI (`apps/ai-service`)**  
`DATABASE_URL`, `REDIS_URL`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `AI_INTERNAL_SECRET`

**Web (`apps/web`)**  
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOCKET_URL`

## Docker

`docker compose up --build` starts postgres, redis, api, web, worker, automation, ai.

> **Hostinger KVM:** CPU-only; XTTS/RVC real-time latency will be high — tune model sizes or add GPU later.

## Enquiry transfer automation

See [apps/automation-service/docs/ENQUIRY_TRANSFER.md](apps/automation-service/docs/ENQUIRY_TRANSFER.md) for the full GDMS enquiry transfer flow (reference images 1–17), consultant rotation, IST follow-up rules, and resume/retry behaviour.

## Android gateway

See [apps/android-gateway-docs/PAIRING.md](apps/android-gateway-docs/PAIRING.md) and Kotlin app under `apps/android/gateway/`.

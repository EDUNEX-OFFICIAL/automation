# Android gateway — pairing & Socket.IO (Phase 2)

1. In the dashboard, go to **Settings → Android gateway pairing** and generate a code.
2. In the app, enter **API base URL** (e.g. `http://10.0.2.2:4000` for the emulator), **deviceId** (stable unique id), and the **pairing code**.
3. Tap **Pair & start gateway** — the app calls `POST /v1/android/claim`.
4. The response includes **`socketToken`** (only in the claim response — store it in secure storage; a new token is issued on the next claim).
5. The foreground service connects via **Socket.IO** with `auth: { deviceId, socketToken }` (flat strings).
6. On the Leads page, **Click-to-call** triggers the API to emit `CALL_TASK` to room `device:{deviceId}`:
   `{ "type":"CALL_TASK","taskId","aiCallId","inquiryId","number" }`.
7. The app dials the SIM via `ACTION_CALL`. **Audio bridge / AI TTS** is a later milestone — `VoiceGateway` hook.

Reconnect: Socket.IO client `reconnection: true`; REST `heartbeat-mvp` every ~30s is an optional backup.

## Phase 3 — call status + token rotate

1. The app needs **`READ_PHONE_STATE`** permission (to listen to call state).
2. For each `CALL_TASK`, the app first POSTs **`DIALING`**, then `RINGING` / `CONNECTED` / `ENDED` (duration estimated from OFFHOOK→IDLE).
3. Not `GET` — use **`POST /v1/android/call-status`** with body: `deviceId`, `socketToken`, `aiCallId`, `phase`, optional `durationSec`, `error`.
4. Dashboard users (dealer room) can listen for **`CALL_STATUS_UPDATE`** events.
5. New socket token: **`POST /v1/android/rotate-socket-token`** `{ deviceId, currentSocketToken }` → `{ socketToken }` — then restart the service / reconnect with the new token.

## Phase 4 — super admin dashboard

- **REST**: `GET /v1/inquiries` without `dealerId` is **SUPER_ADMIN** only (combined list + `dealerName`).
- **Socket**: super admin joins every **dealer room** so live events and call status arrive from all tenants (reconnect the socket when a new dealer is added).

## Phase 5 — encrypted credentials

- After claim, save **`socketToken` + API base + deviceId** in `EncryptedSharedPreferences` (`security-crypto`).
- **Start gateway (saved token)** — start the service without pairing again (if the token is still valid on the API).
- **Clear saved credentials** — wipe prefs and reset fields.
- If you used **`/rotate-socket-token`**, the old saved token is invalid — **pair** again or clear prefs manually and run the flow again.

## Phase 6 — WebRTC ICE API + biometric + network config

- Dashboard / native clients: **`GET /v1/integrations/webrtc`** (Bearer JWT) → `iceServers` for `RTCPeerConnection`.
- **Start gateway (saved token)**: **fingerprint / face unlock** first (if enrolled); otherwise start directly and show a toast.
- **`network_security_config`**: dev-friendly HTTP for now; use HTTPS in production and follow the pin-set example in the README / XML comments.

## Prisma migrate

**Phase 2:** `AndroidDevice.socketTokenHash`:

`pnpm --filter @gdms/database exec prisma migrate deploy`

**Phase 3:** `AiCall.lastCallPhase`, `AiCall.callEndedAt` — same command (folder `20260215103000_phase3_call_status`).

(Or on a new database, run `prisma db push`.)

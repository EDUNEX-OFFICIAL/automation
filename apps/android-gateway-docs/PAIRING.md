# Android gateway — pairing & Socket.IO (Phase 2)

1. Dashboard **Settings → Android gateway pairing** se code generate karein.
2. App mein **API base URL** (e.g. `http://10.0.2.2:4000` emulator ke liye) + **deviceId** (stable unique) + **pairing code** bharo.
3. **Pair & start gateway** dabao — app `POST /v1/android/claim` karti hai.
4. Response mein **`socketToken`** aata hai (sirf claim response mein — isko secure storage mein rakho, dubara claim par naya milega).
5. Foreground service **Socket.IO** se connect: `auth: { deviceId, socketToken }` (flat strings).
6. Leads page **Click-to-call** par API `CALL_TASK` emit karti hai room `device:{deviceId}` par:
   `{ "type":"CALL_TASK","taskId","aiCallId","inquiryId","number" }`.
7. App `ACTION_CALL` se SIM dial karti hai. **Audio bridge / AI TTS** abhi next milestone — `VoiceGateway` hook.

Reconnect: Socket.IO client `reconnection: true`; REST `heartbeat-mvp` har ~30s optional backup hai.

## Phase 3 — call status + token rotate

1. App ko **`READ_PHONE_STATE`** permission chahiye (call state sunne ke liye).
2. Har `CALL_TASK` par app pehle **`DIALING`** POST karti hai, phir `RINGING` / `CONNECTED` / `ENDED` (duration estimate OFFHOOK→IDLE).
3. API `GET` nahi — **`POST /v1/android/call-status`** body: `deviceId`, `socketToken`, `aiCallId`, `phase`, optional `durationSec`, `error`.
4. Dashboard users (dealer room) **`CALL_STATUS_UPDATE`** event sun sakte hain.
5. Naya socket token: **`POST /v1/android/rotate-socket-token`** `{ deviceId, currentSocketToken }` → `{ socketToken }` — phir service restart / reconnect with naya token.

## Phase 4 — super admin dashboard

- **REST**: `GET /v1/inquiries` bina `dealerId` sirf **SUPER_ADMIN** (combined list + `dealerName`).
- **Socket**: super admin har **dealer room** join karta hai taake live events / call status sab tenants se aayein (naya dealer add par socket reconnect karo).

## Phase 5 — encrypted credentials

- Claim ke baad **`socketToken` + API base + deviceId** `EncryptedSharedPreferences` mein save (`security-crypto`).
- **Start gateway (saved token)** — bina dubara pair kiye service start (agar token API par valid hai).
- **Clear saved credentials** — prefs wipe + fields reset.
- Agar **`/rotate-socket-token`** use kiya ho to purana saved token invalid — dubara **pair** karo ya manually prefs clear karke naya flow.

## Phase 6 — WebRTC ICE API + biometric + network config

- Dashboard / native clients: **`GET /v1/integrations/webrtc`** (Bearer JWT) → `iceServers` for `RTCPeerConnection`.
- **Start gateway (saved token)**: pehle **fingerprint / face unlock** (agar enrolled hai); warna direct start + toast.
- **`network_security_config`**: abhi dev-friendly HTTP; production mein HTTPS + pin-set example README / XML comment follow karo.

## Prisma migrate

**Phase 2:** `AndroidDevice.socketTokenHash`:

`pnpm --filter @gdms/database exec prisma migrate deploy`

**Phase 3:** `AiCall.lastCallPhase`, `AiCall.callEndedAt` — same command (folder `20260215103000_phase3_call_status`).

(ya nayi DB par `prisma db push`.)

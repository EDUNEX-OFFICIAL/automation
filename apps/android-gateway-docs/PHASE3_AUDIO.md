# Phase 3+ — audio bridge (planned)

Phase 3 is **telephony status** (dial / ring / connected / end) to the dashboard. **Live audio** (MIC uplink, TTS / playback downlink, server-side mixing) is **not** in this milestone.

## Phase 5 contract (no media yet)

Monorepo defines Socket.IO **`VOICE_SESSION_SIGNAL`** and `VoiceSessionSignalPayload` (`offer` | `answer` | `ice` | `hangup` + opaque `payload` string). Server **does not** relay media today — enabling `VOICE_BRIDGE_ENABLED` on the API logs intent; SFU/TURN is Phase 7+.

**Phase 6:** authenticated clients can fetch **`GET /v1/integrations/webrtc`** for `iceServers` (STUN default, optional TURN from env). No SFU yet — use this to bootstrap browser `RTCPeerConnection` once signalling is wired.

Likely next building blocks:

- Android: `AudioRecord` +编码 (Opus/PCM over WebRTC or a custom WebSocket binary channel) guarded by the same device socket token.
- API: a dedicated media session room or SFU; never send raw MIC to browsers without explicit consent + dealer policy.
- AI service: stream partial ASR back to automation for “conversation state” if you add real voice bots.

Revisit when GDMS conversation audio must be captured or when the AI agent must speak on the PSTN leg.

import type { FastifyInstance } from "fastify";
import { authPreHandler } from "../lib/auth-pre.js";
import { env } from "../config.js";

/** RTCIceServer-compatible entries for browser / native WebRTC clients. */
function buildIceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const out: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];
  const stunList = env.WEBRTC_STUN_URLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const u of stunList) {
    out.push({ urls: u });
  }
  const turnRaw = env.WEBRTC_TURN_URLS?.trim();
  if (turnRaw && env.WEBRTC_TURN_USERNAME && env.WEBRTC_TURN_PASSWORD) {
    const urls = turnRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length > 0) {
      out.push({
        urls: urls.length === 1 ? urls[0]! : urls,
        username: env.WEBRTC_TURN_USERNAME,
        credential: env.WEBRTC_TURN_PASSWORD,
      });
    }
  }
  return out;
}

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/integrations/webrtc", { preHandler: authPreHandler }, async () => ({
    voiceBridgeEnabled: env.VOICE_BRIDGE_ENABLED,
    iceServers: buildIceServers(),
  }));
}

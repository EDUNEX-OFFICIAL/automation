import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authPreHandler } from "../lib/auth-pre.js";
import { env } from "../config.js";
import { prisma } from "../prisma.js";
import { canAccessDealer } from "@gdms/auth";

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

  app.post("/v1/voice-profiles", { preHandler: authPreHandler }, async (req, reply) => {
    const body = z
      .object({
        dealerId: z.string(),
        artifactPath: z.string().min(1),
        modelVersion: z.string().default("1"),
      })
      .parse(req.body);
    if (!canAccessDealer(req.user!.dealerId, body.dealerId, req.user!.role)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const row = await prisma.voiceProfile.create({
      data: {
        dealerId: body.dealerId,
        userId: req.user!.sub,
        artifactPath: body.artifactPath,
        modelVersion: body.modelVersion,
        status: "READY",
      },
    });
    return row;
  });
}

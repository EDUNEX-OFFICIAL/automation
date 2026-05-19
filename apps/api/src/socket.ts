import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import type { AccessTokenPayload } from "@gdms/auth";
import { verifyPassword } from "@gdms/auth";
import { env } from "./config.js";
import {
  attachRedisConnectionWarnings,
  redis,
  redisConnectionOptions,
  WORKFLOW_REDIS_CHANNEL,
} from "./redis.js";
import { Redis } from "ioredis";
import { appendRunLogBuffer } from "./run-log-buffer.js";
import { prisma } from "./prisma.js";
import {
  SocketEvents,
  roomForDealer,
  roomForWorkflowRun,
  roomForAndroidDevice,
} from "@gdms/shared";
import type {
  OtpRequiredPayload,
  StepCompletedPayload,
  ScreenshotFramePayload,
  LogLinePayload,
  WorkflowCompletedPayload,
  WorkflowPausedUserPayload,
} from "@gdms/shared";

export type IoServer = Server;

let ioRef: Server | null = null;
let workflowEventsSubscribed = false;

export function isWorkflowEventsSubscribed(): boolean {
  return workflowEventsSubscribed;
}

export function getIo(): Server {
  if (!ioRef) throw new Error("Socket.IO not initialized");
  return ioRef;
}

export function attachSocket(httpServer: HttpServer): Server {
  if (ioRef) return ioRef;
  const corsOrigins = env.CORS_ORIGIN.split(",").map((s) => s.trim());
  const io = new Server(httpServer, {
    cors:
      env.NODE_ENV === "development"
        ? { origin: true, credentials: true }
        : {
            origin: corsOrigins,
            credentials: true,
          },
    connectTimeout: 45_000,
    pingTimeout: 25_000,
  });
  ioRef = io;

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as Record<string, unknown>;
    const pickStr = (v: unknown): string | undefined => {
      if (typeof v === "string") return v;
      if (Array.isArray(v) && typeof v[0] === "string") return v[0];
      return undefined;
    };
    const token =
      pickStr(auth.token) ??
      (typeof socket.handshake.query.token === "string" ? socket.handshake.query.token : undefined);
    if (token) {
      try {
        const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
        (socket.data as { user?: AccessTokenPayload; authKind?: string }).user = payload;
        (socket.data as { authKind?: string }).authKind = "jwt";
        next();
        return;
      } catch {
        /* device auth */
      }
    }
    const deviceId = pickStr(auth.deviceId);
    const socketToken = pickStr(auth.socketToken);
    if (deviceId && socketToken) {
      const dev = await prisma.androidDevice.findUnique({ where: { deviceId } });
      if (dev?.socketTokenHash) {
        const ok = await verifyPassword(socketToken, dev.socketTokenHash);
        if (ok) {
          (socket.data as { deviceId?: string; authKind?: string }).deviceId = deviceId;
          (socket.data as { authKind?: string }).authKind = "device";
          next();
          return;
        }
      }
    }
    next(new Error("unauthorized"));
  });

  io.on("connection", (socket) => {
    const data = socket.data as {
      authKind?: string;
      deviceId?: string;
      user?: AccessTokenPayload;
    };

    if (data.authKind === "device" && data.deviceId) {
      void socket.join(roomForAndroidDevice(data.deviceId));
      void prisma.androidDevice.updateMany({
        where: { deviceId: data.deviceId },
        data: { lastSeenAt: new Date(), status: "ONLINE" },
      });
    } else {
      const user = data.user as AccessTokenPayload;
      void (async () => {
        try {
          if (user?.role === "SUPER_ADMIN") {
            const dealers = await prisma.dealer.findMany({ select: { id: true } });
            await Promise.all(dealers.map((d) => socket.join(roomForDealer(d.id))));
          } else if (user?.dealerId) {
            await socket.join(roomForDealer(user.dealerId));
          }
        } catch (e) {
          console.error("socket dealer room join", e);
        }
      })();
      socket.on("join_run", (runId: string) => {
        void socket.join(roomForWorkflowRun(runId));
      });
    }

    socket.on(SocketEvents.ANDROID_HEARTBEAT, async (payload: { deviceId: string }) => {
      const dev = await prisma.androidDevice.findFirst({
        where: { deviceId: payload.deviceId },
      });
      if (dev) {
        await prisma.androidDevice.update({
          where: { id: dev.id },
          data: { lastSeenAt: new Date(), status: "ONLINE" },
        });
        io.to(roomForDealer(dev.dealerId)).emit(SocketEvents.ANDROID_HEARTBEAT, payload);
      }
    });
  });

  const sub = new Redis(env.REDIS_URL, redisConnectionOptions);
  attachRedisConnectionWarnings(sub, "api-subscribe");

  let subscribeDone = false;
  const ensureSubscribed = async (): Promise<void> => {
    if (subscribeDone) return;
    try {
      await sub.subscribe(WORKFLOW_REDIS_CHANNEL);
      subscribeDone = true;
      workflowEventsSubscribed = true;
      console.info(`[redis:api-subscribe] listening on ${WORKFLOW_REDIS_CHANNEL}`);
    } catch (e) {
      workflowEventsSubscribed = false;
      console.error("[redis:api-subscribe] subscribe failed", e);
    }
  };

  sub.on("ready", () => {
    void ensureSubscribed();
  });
  sub.on("close", () => {
    subscribeDone = false;
    workflowEventsSubscribed = false;
  });
  sub.on("error", (e: Error) => {
    subscribeDone = false;
    workflowEventsSubscribed = false;
    console.error("[redis:api-subscribe] connection error", e.message);
  });
  if (sub.status === "ready") {
    void ensureSubscribed();
  }

  sub.on("message", (_channel: string, message: string) => {
    try {
      const evt = JSON.parse(message) as {
        type: string;
        dealerId?: string;
        payload?: unknown;
      };
      if (!evt.type) return;
      if (evt.type === SocketEvents.OTP_REQUIRED) {
        const p = evt.payload as OtpRequiredPayload;
        if (evt.dealerId) io.to(roomForDealer(evt.dealerId)).emit(SocketEvents.OTP_REQUIRED, p);
        io.to(roomForWorkflowRun(p.workflowRunId)).emit(SocketEvents.OTP_REQUIRED, p);
      } else if (evt.type === SocketEvents.STEP_COMPLETED) {
        const p = evt.payload as StepCompletedPayload;
        if (evt.dealerId) io.to(roomForDealer(evt.dealerId)).emit(SocketEvents.STEP_COMPLETED, p);
        io.to(roomForWorkflowRun(p.workflowRunId)).emit(SocketEvents.STEP_COMPLETED, p);
      } else if (evt.type === SocketEvents.SCREENSHOT_FRAME) {
        const p = evt.payload as ScreenshotFramePayload;
        if (evt.dealerId) io.to(roomForDealer(evt.dealerId)).emit(SocketEvents.SCREENSHOT_FRAME, p);
        io.to(roomForWorkflowRun(p.workflowRunId)).emit(SocketEvents.SCREENSHOT_FRAME, p);
      } else if (evt.type === SocketEvents.LOG_LINE) {
        const p = evt.payload as LogLinePayload;
        void appendRunLogBuffer(p).catch((e) => console.error("run log buffer", e));
        if (evt.dealerId) io.to(roomForDealer(evt.dealerId)).emit(SocketEvents.LOG_LINE, p);
        io.to(roomForWorkflowRun(p.workflowRunId)).emit(SocketEvents.LOG_LINE, p);
      } else if (evt.type === SocketEvents.WORKFLOW_STARTED && evt.dealerId) {
        io.to(roomForDealer(evt.dealerId)).emit(evt.type, evt.payload);
      } else if (evt.type === SocketEvents.WORKFLOW_FAILED && evt.dealerId) {
        const p = evt.payload as { workflowRunId?: string; error?: string };
        io.to(roomForDealer(evt.dealerId)).emit(evt.type, evt.payload);
        if (p?.workflowRunId) io.to(roomForWorkflowRun(p.workflowRunId)).emit(evt.type, evt.payload);
      } else if (evt.type === SocketEvents.WORKFLOW_PAUSED_USER && evt.dealerId) {
        const p = evt.payload as WorkflowPausedUserPayload;
        io.to(roomForDealer(evt.dealerId)).emit(evt.type, evt.payload);
        if (p?.workflowRunId) io.to(roomForWorkflowRun(p.workflowRunId)).emit(evt.type, evt.payload);
      } else if (evt.type === SocketEvents.WORKFLOW_COMPLETED && evt.dealerId) {
        const p = evt.payload as WorkflowCompletedPayload;
        io.to(roomForDealer(evt.dealerId)).emit(evt.type, evt.payload);
        if (p?.workflowRunId) io.to(roomForWorkflowRun(p.workflowRunId)).emit(evt.type, evt.payload);
      } else if (evt.type === SocketEvents.GDMS_SESSION_REDIRECTED) {
        const p = evt.payload as { workflowRunId?: string };
        if (evt.dealerId) io.to(roomForDealer(evt.dealerId)).emit(evt.type, evt.payload);
        if (p?.workflowRunId) io.to(roomForWorkflowRun(p.workflowRunId)).emit(evt.type, evt.payload);
      } else if (evt.type === SocketEvents.LEAD_CLASSIFIED && evt.dealerId) {
        io.to(roomForDealer(evt.dealerId)).emit(evt.type, evt.payload);
      } else if (evt.type === SocketEvents.CALL_STARTED && evt.dealerId) {
        io.to(roomForDealer(evt.dealerId)).emit(evt.type, evt.payload);
      } else if (evt.type === SocketEvents.CALL_COMPLETED && evt.dealerId) {
        io.to(roomForDealer(evt.dealerId)).emit(evt.type, evt.payload);
      }
    } catch (e) {
      console.error("Bad redis event", e);
    }
  });

  return io;
}

export async function publishWorkflowEvent(event: {
  type: string;
  dealerId: string;
  payload: unknown;
}): Promise<void> {
  await redis.publish(WORKFLOW_REDIS_CHANNEL, JSON.stringify(event));
}

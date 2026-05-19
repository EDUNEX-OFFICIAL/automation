import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { env } from "./config.js";
import { attachSocket } from "./socket.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerDealerRoutes } from "./routes/dealers.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerGdmsRoutes } from "./routes/gdms-account.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerWorkflowRunRoutes } from "./routes/workflow-runs.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerAndroidRoutes } from "./routes/android.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerDealerAutomationSettingsRoutes } from "./routes/dealer-automation-settings.js";
import { startFollowUpSkipScheduler } from "./lib/follow-up-skip-scheduler.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  /** Socket.IO expects /socket.io/; Fastify 404s /socket.io? without trailing slash (Next proxy path). */
  app.addHook("onRequest", async (req) => {
    const raw = req.raw.url ?? "";
    if (raw === "/socket.io" || raw.startsWith("/socket.io?")) {
      req.raw.url = raw.replace(/^\/socket.io/, "/socket.io/");
    }
  });

  const corsOrigins = env.CORS_ORIGIN.split(",").map((s) => s.trim());
  await app.register(cors, {
    origin: env.NODE_ENV === "development" ? true : corsOrigins,
    credentials: true,
  });
  await app.register(cookie);

  app.get("/health", async () => {
    const { isWorkflowEventsSubscribed } = await import("./socket.js");
    return {
      ok: true,
      service: "gdms-api",
      port: env.PORT,
      workflowEventsSubscribed: isWorkflowEventsSubscribed(),
    };
  });

  await registerAuthRoutes(app);
  await registerMeRoutes(app);
  await registerDealerRoutes(app);
  await registerUserRoutes(app);
  await registerGdmsRoutes(app);
  await registerWorkflowRoutes(app);
  await registerWorkflowRunRoutes(app);
  await registerLeadRoutes(app);
  await registerAndroidRoutes(app);
  await registerIntegrationRoutes(app);
  await registerDealerAutomationSettingsRoutes(app);

  await app.ready();
  startFollowUpSkipScheduler();
  attachSocket(app.server);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`API listening on ${env.PORT} (Socket.IO bound before bind)`);
  if (env.VOICE_BRIDGE_ENABLED) {
    app.log.info(
      "VOICE_BRIDGE_ENABLED: use GET /v1/integrations/webrtc for iceServers; VOICE_SESSION_SIGNAL still has no SFU relay",
    );
  }
}

main().catch((err) => {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "EADDRINUSE") {
    console.error(
      `\n[@gdms/api] Port ${env.PORT} is already in use.\n` +
        `  Another process is bound (often a previous "pnpm dev").\n` +
        `  Windows: netstat -ano | findstr :${env.PORT}  then  taskkill /PID <pid> /F\n` +
        `  Or change PORT in apps/api/.env and match API_UPSTREAM_URL / NEXT_PUBLIC_SOCKET_URL in apps/web/.env\n`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

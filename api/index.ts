import express from "express";
import cors from "cors";
import { chatRouter } from "../server/dist/routes/chat.js";
import { projectsRouter } from "../server/dist/routes/projects.js";
import { matchesRouter } from "../server/dist/routes/matches.js";
import { paymentsRouter } from "../server/dist/routes/payments.js";
import { visitsRouter } from "../server/dist/routes/visits.js";
import { connectionChatRouter } from "../server/dist/routes/connection-chat.js";
import { whatsappWebhookRouter } from "../server/dist/routes/webhooks/whatsapp.js";
import { stripeWebhookRouter } from "../server/dist/routes/webhooks/stripe.js";

const app = express();
// #region agent log
fetch("http://127.0.0.1:7803/ingest/440abadd-e42c-4ad6-b3c7-7a5e0395097a", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a202bb" },
  body: JSON.stringify({
    sessionId: "a202bb",
    hypothesisId: "H3",
    location: "api/index.ts:module",
    message: "api_module_loaded",
    data: { ok: true },
    timestamp: Date.now(),
    runId: "emit-cjs",
  }),
}).catch(() => {});
// #endregion
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/chat", chatRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/matches", matchesRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/visits", visitsRouter);
app.use("/api/connections", connectionChatRouter);
app.use("/webhooks/whatsapp", whatsappWebhookRouter);
app.use("/webhooks/stripe", stripeWebhookRouter);

export default app;

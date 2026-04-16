import "dotenv/config";
import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat.js";
import { projectsRouter } from "./routes/projects.js";
import { matchesRouter } from "./routes/matches.js";
import { paymentsRouter } from "./routes/payments.js";
import { visitsRouter } from "./routes/visits.js";
import { connectionChatRouter } from "./routes/connection-chat.js";
import { whatsappWebhookRouter } from "./routes/webhooks/whatsapp.js";
import { stripeWebhookRouter } from "./routes/webhooks/stripe.js";
import { startWorker } from "./jobs/worker.js";

const app = express();
const port = parseInt(process.env.PORT || "3001", 10);

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

app.listen(port, () => {
  console.log(`[Airsup] Server listening on http://localhost:${port}`);
  startWorker();
});

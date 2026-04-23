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
import { internalRouter } from "../server/dist/routes/internal.js";
import { outreachRouter } from "../server/dist/routes/outreach.js";
import { adminRouter } from "../server/dist/routes/admin.js";
import { factoriesRouter } from "../server/dist/routes/factories.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/chat", chatRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/matches", matchesRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/visits", visitsRouter);
app.use("/api/connections", connectionChatRouter);
app.use("/api/internal", internalRouter);
app.use("/api/outreach", outreachRouter);
app.use("/api/admin", adminRouter);
app.use("/api/factories", factoriesRouter);
app.use("/webhooks/whatsapp", whatsappWebhookRouter);
app.use("/webhooks/stripe", stripeWebhookRouter);

export default app;

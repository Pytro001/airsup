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
import { internalRouter } from "./routes/internal.js";
import { outreachRouter } from "./routes/outreach.js";
import { adminRouter } from "./routes/admin.js";
import { factoriesRouter } from "./routes/factories.js";
import { profileRouter } from "./routes/profile.js";
import { intakeImportRouter } from "./routes/intake-import.js";
import { placesRouter } from "./routes/places.js";
import { notifyRouter } from "./routes/notify.js";
import { startWorker } from "./jobs/worker.js";
import { registerAllSkills, triggerSkill } from "./skills/index.js";

const app = express();
const port = parseInt(process.env.PORT || "3001", 10);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/places", placesRouter);

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
app.use("/api/profile", profileRouter);
app.use("/api/intake", intakeImportRouter);
app.use("/api/notify", notifyRouter);
app.use("/webhooks/whatsapp", whatsappWebhookRouter);
app.use("/webhooks/stripe", stripeWebhookRouter);

// Project-created webhook (called by signup form after creating a project)
app.post("/webhooks/project-created", async (req, res) => {
  const { projectId, buyerId } = req.body ?? {};
  if (!projectId || !buyerId) {
    res.status(400).json({ error: "projectId and buyerId required" });
    return;
  }
  res.status(200).json({ ok: true });
  triggerSkill("signup", { projectId, buyerId });
});

app.listen(port, () => {
  console.log(`[Airsup] Server listening on http://localhost:${port}`);
  registerAllSkills();
  startWorker();
});

import type { VercelRequest, VercelResponse } from "@vercel/node";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

let routesLoaded = false;

async function loadRoutes() {
  if (routesLoaded) return;
  const { chatRouter } = await import("../server/dist/routes/chat.js");
  const { projectsRouter } = await import("../server/dist/routes/projects.js");
  const { matchesRouter } = await import("../server/dist/routes/matches.js");
  const { paymentsRouter } = await import("../server/dist/routes/payments.js");
  const { visitsRouter } = await import("../server/dist/routes/visits.js");
  const { whatsappWebhookRouter } = await import("../server/dist/routes/webhooks/whatsapp.js");
  const { stripeWebhookRouter } = await import("../server/dist/routes/webhooks/stripe.js");

  app.use("/api/chat", chatRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/matches", matchesRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/visits", visitsRouter);
  app.use("/webhooks/whatsapp", whatsappWebhookRouter);
  app.use("/webhooks/stripe", stripeWebhookRouter);

  routesLoaded = true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await loadRoutes();
  app(req as any, res as any);
}

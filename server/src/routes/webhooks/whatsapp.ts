import { Router } from "express";
import type { Request, Response } from "express";
import { verifyWebhook } from "../../services/whatsapp.js";
import { triggerSkill } from "../../skills/index.js";

export const whatsappWebhookRouter = Router();

whatsappWebhookRouter.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  const result = verifyWebhook(mode, token, challenge);
  if (result) {
    res.status(200).send(result);
  } else {
    res.status(403).send("Forbidden");
  }
});

whatsappWebhookRouter.post("/", async (req: Request, res: Response) => {
  res.status(200).send("EVENT_RECEIVED");

  try {
    const entry = (req.body.entry as any[]) ?? [];
    for (const e of entry) {
      const changes = e.changes ?? [];
      for (const c of changes) {
        const msgs = c.value?.messages ?? [];
        for (const m of msgs) {
          await triggerSkill("project-router", {
            from: m.from,
            text: m.text?.body ?? m.caption ?? "",
            type: m.type,
            raw: m,
          });
        }
      }
    }
  } catch (err) {
    console.error("[WhatsApp] webhook processing error:", err);
  }
});

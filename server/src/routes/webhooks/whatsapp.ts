import { Router } from "express";
import type { Request, Response } from "express";
import { verifyWebhook, parseWebhookPayload } from "../../services/whatsapp.js";
import { supabaseAdmin } from "../../services/supabase.js";

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

  const messages = parseWebhookPayload(req.body);
  for (const msg of messages) {
    try {
      const { data: match } = await supabaseAdmin
        .from("matches")
        .select("id, project_id, factory_id, status")
        .or(`wa_group_id.eq.${msg.from}`)
        .maybeSingle();

      if (match) {
        console.log(`[WhatsApp] Message from ${msg.from} on match ${match.id}: ${msg.text.slice(0, 100)}`);
      } else {
        console.log(`[WhatsApp] Unmatched message from ${msg.from}: ${msg.text.slice(0, 100)}`);
      }
    } catch (err) {
      console.error("[WhatsApp] webhook processing error:", err);
    }
  }
});

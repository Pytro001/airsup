import { Router } from "express";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../../services/supabase.js";

export const stripeWebhookRouter = Router();

stripeWebhookRouter.post("/", async (req: Request, res: Response) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    res.json({ received: true, beta: true });
    return;
  }

  const signature = req.headers["stripe-signature"] as string;
  if (!signature) {
    res.status(400).send("Missing signature");
    return;
  }

  try {
    const { verifyWebhookSignature } = await import("../../services/stripe.js");
    const event = verifyWebhookSignature(JSON.stringify(req.body), signature);
    if (!event) {
      res.status(400).send("Invalid signature");
      return;
    }

    switch (event.type) {
      case "payment_intent.amount_capturable_updated": {
        const intent = event.data.object as any;
        const matchId = intent.metadata?.match_id;
        if (matchId) {
          await supabaseAdmin
            .from("payments")
            .update({ status: "held", updated_at: new Date().toISOString() })
            .eq("stripe_intent_id", intent.id);
        }
        break;
      }

      case "payment_intent.succeeded": {
        const intent = event.data.object as any;
        await supabaseAdmin
          .from("payments")
          .update({ status: "released", updated_at: new Date().toISOString() })
          .eq("stripe_intent_id", intent.id);
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as any;
        const intentId = charge.payment_intent;
        if (intentId) {
          await supabaseAdmin
            .from("payments")
            .update({ status: "refunded", updated_at: new Date().toISOString() })
            .eq("stripe_intent_id", intentId);
        }
        break;
      }
    }
  } catch (err) {
    console.error("[Stripe webhook] processing error:", err);
  }

  res.json({ received: true });
});

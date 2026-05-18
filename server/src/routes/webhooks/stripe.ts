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

      case "checkout.session.completed": {
        const session = event.data.object as any;

        // Legacy handover flow
        const outreachId = session.metadata?.outreach_id;
        if (outreachId) {
          const { triggerSkill } = await import("../../skills/index.js");
          await triggerSkill("handover", { outreachId });
        }

        // Subscription activation: find profile by email, mark subscribed, message them
        if (session.mode === "subscription" || session.mode === "payment") {
          const email = session.customer_details?.email as string | undefined;
          if (email) {
            // Derive plan from amount
            const amount = session.amount_total as number;
            const plan = amount <= 3000 ? "build" : amount <= 10000 ? "manufacture" : "scale";

            const { data: profile } = await supabaseAdmin
              .from("profiles")
              .select("id, phone, display_name, subscribed")
              .eq("email", email)
              .maybeSingle();

            if (profile && !profile.subscribed) {
              await supabaseAdmin
                .from("profiles")
                .update({ subscribed: true, plan })
                .eq("id", profile.id);

              // Send WhatsApp notification
              const phone = (profile as any).phone as string | undefined;
              if (phone) {
                const { sendWhatsAppMessage } = await import("../../services/whatsapp.js");
                const name = (profile as any).display_name as string | undefined;
                await sendWhatsAppMessage(
                  phone,
                  `Hi${name ? " " + name : ""}! I'm Supi, your Airsup sourcing agent. 🔍\n\nYour subscription is now active. I'm starting my search for the right suppliers now. Feel free to reply with more files or details about your project.`
                );
              }
            }
          }
        }
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

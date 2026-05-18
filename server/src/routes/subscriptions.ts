import { Router } from "express";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../services/supabase.js";

export const subscriptionsRouter = Router();

const VALID_PLANS = ["build", "manufacture", "scale"] as const;

subscriptionsRouter.post("/verify", async (req: Request, res: Response) => {
  const { session_id, plan } = req.body as { session_id?: string; plan?: string };

  if (!session_id || !plan) {
    res.status(400).json({ error: "session_id and plan required" });
    return;
  }

  if (!VALID_PLANS.includes(plan as any)) {
    res.status(400).json({ error: "Invalid plan" });
    return;
  }

  // Check if already verified (reuse for same session)
  const { data: existing } = await supabaseAdmin
    .from("subscription_sessions")
    .select("id, plan, email, used")
    .eq("stripe_session_id", session_id)
    .maybeSingle();

  if (existing) {
    res.json({ valid: true, plan: existing.plan, email: existing.email });
    return;
  }

  // Verify with Stripe
  if (!process.env.STRIPE_SECRET_KEY) {
    // Dev mode: skip Stripe verification
    await supabaseAdmin.from("subscription_sessions").insert({
      stripe_session_id: session_id,
      plan,
      email: null,
    });
    res.json({ valid: true, plan });
    return;
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-04-30.basil" as any });
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.status !== "complete" && session.payment_status !== "paid") {
      res.status(402).json({ error: "Payment not completed" });
      return;
    }

    const email = session.customer_details?.email || null;

    await supabaseAdmin.from("subscription_sessions").insert({
      stripe_session_id: session_id,
      plan,
      email,
    });

    res.json({ valid: true, plan, email });
  } catch (err: any) {
    console.error("[Subscriptions] verify error:", err);
    res.status(400).json({ error: "Invalid session" });
  }
});

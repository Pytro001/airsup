import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";

export const paymentsRouter = Router();

const BETA_MODE = !process.env.STRIPE_SECRET_KEY;

paymentsRouter.post("/create", requireAuth, async (req: AuthRequest, res: Response) => {
  const { match_id, amount_cents, currency } = req.body as {
    match_id: string;
    amount_cents: number;
    currency?: string;
  };

  if (!match_id || !amount_cents) {
    res.status(400).json({ error: "match_id and amount_cents required" });
    return;
  }

  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("id, projects!inner(user_id, title)")
    .eq("id", match_id)
    .single();

  if (!match || (match as any).projects?.user_id !== req.userId) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  if (BETA_MODE) {
    const { data: payment } = await supabaseAdmin.from("payments").insert({
      match_id,
      amount_cents,
      currency: currency || "usd",
      stripe_intent_id: `beta_free_${Date.now()}`,
      status: "held",
    }).select("id").single();

    res.json({ beta: true, paymentId: payment?.id, message: "Free during beta — no payment required." });
    return;
  }

  try {
    const { createEscrowPayment } = await import("../services/stripe.js");
    const { clientSecret, intentId } = await createEscrowPayment({
      amountCents: amount_cents,
      currency: currency || "usd",
      matchId: match_id,
      buyerEmail: req.userId! + "@placeholder.com",
      description: `Airsup escrow: ${(match as any).projects?.title}`,
    });

    await supabaseAdmin.from("payments").insert({
      match_id,
      amount_cents,
      currency: currency || "usd",
      stripe_intent_id: intentId,
      status: "pending",
    });

    res.json({ clientSecret, intentId });
  } catch (err) {
    console.error("[Payments] create error:", err);
    res.status(500).json({ error: "Payment creation failed" });
  }
});

paymentsRouter.post("/release", requireAuth, async (req: AuthRequest, res: Response) => {
  const { payment_id } = req.body as { payment_id: string };

  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select("id, stripe_intent_id, status")
    .eq("id", payment_id)
    .single();

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  if (BETA_MODE || payment.stripe_intent_id?.startsWith("beta_free_")) {
    await supabaseAdmin.from("payments").update({ status: "released", updated_at: new Date().toISOString() }).eq("id", payment_id);
    res.json({ beta: true, status: "released" });
    return;
  }

  if (payment.status !== "held") {
    res.status(400).json({ error: "Payment not in held state" });
    return;
  }

  try {
    const { capturePayment } = await import("../services/stripe.js");
    const success = await capturePayment(payment.stripe_intent_id!);
    if (success) {
      await supabaseAdmin.from("payments").update({ status: "released", updated_at: new Date().toISOString() }).eq("id", payment_id);
      res.json({ status: "released" });
    } else {
      res.status(500).json({ error: "Release failed" });
    }
  } catch (err) {
    res.status(500).json({ error: "Release failed" });
  }
});

paymentsRouter.post("/refund", requireAuth, async (req: AuthRequest, res: Response) => {
  const { payment_id, reason } = req.body as { payment_id: string; reason?: string };

  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select("id, stripe_intent_id, status")
    .eq("id", payment_id)
    .single();

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  if (BETA_MODE || payment.stripe_intent_id?.startsWith("beta_free_")) {
    await supabaseAdmin.from("payments").update({ status: "refunded", updated_at: new Date().toISOString() }).eq("id", payment_id);
    res.json({ beta: true, status: "refunded" });
    return;
  }

  if (payment.status !== "held" && payment.status !== "released") {
    res.status(400).json({ error: "Payment cannot be refunded" });
    return;
  }

  try {
    const { refundPayment } = await import("../services/stripe.js");
    const success = await refundPayment(payment.stripe_intent_id!, reason);
    if (success) {
      await supabaseAdmin.from("payments").update({ status: "refunded", updated_at: new Date().toISOString() }).eq("id", payment_id);
      res.json({ status: "refunded" });
    } else {
      res.status(500).json({ error: "Refund failed" });
    }
  } catch (err) {
    res.status(500).json({ error: "Refund failed" });
  }
});

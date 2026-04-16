import Stripe from "stripe";

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    stripeClient = new Stripe(key, { apiVersion: "2025-04-30.basil" as any });
  }
  return stripeClient;
}

export async function createEscrowPayment(params: {
  amountCents: number;
  currency: string;
  matchId: string;
  buyerEmail: string;
  description: string;
}): Promise<{ clientSecret: string; intentId: string }> {
  const stripe = getStripe();

  const intent = await stripe.paymentIntents.create({
    amount: params.amountCents,
    currency: params.currency,
    capture_method: "manual",
    receipt_email: params.buyerEmail,
    description: params.description,
    metadata: { match_id: params.matchId, platform: "airsup" },
  });

  return {
    clientSecret: intent.client_secret!,
    intentId: intent.id,
  };
}

export async function capturePayment(intentId: string): Promise<boolean> {
  const stripe = getStripe();
  try {
    await stripe.paymentIntents.capture(intentId);
    return true;
  } catch (err) {
    console.error("[Stripe] capture failed:", err);
    return false;
  }
}

export async function refundPayment(intentId: string, reason?: string): Promise<boolean> {
  const stripe = getStripe();
  try {
    await stripe.refunds.create({
      payment_intent: intentId,
      reason: "requested_by_customer",
      metadata: { airsup_reason: reason || "platform_protection" },
    });
    return true;
  } catch (err) {
    console.error("[Stripe] refund failed:", err);
    return false;
  }
}

export function verifyWebhookSignature(payload: string | Buffer, signature: string): Stripe.Event | null {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return null;
  try {
    return stripe.webhooks.constructEvent(payload, signature, secret);
  } catch {
    return null;
  }
}

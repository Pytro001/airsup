import Stripe from "stripe";
import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";

export async function paymentTrigger({ outreachId }: { outreachId: string }) {
  const { data: outreach } = await supabaseAdmin
    .from("wa_outreach")
    .select("*, factories(*), projects(*, profiles!projects_user_id_fkey(*))")
    .eq("id", outreachId)
    .single();

  if (!outreach) return;

  const buyer = (outreach.projects as any)?.profiles;
  const supplier = (outreach as any).factories;
  const sampleCost: number = outreach.sample_cost ?? 0;
  const commission = Math.round(sampleCost * 0.07 * 100) / 100;
  const total = sampleCost + commission;

  let paymentLink = `${process.env.AIRSUP_URL}/projects/${(outreach as any).project_id}/pay`;

  if (process.env.STRIPE_SECRET_KEY) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: { name: `Sample order: ${supplier?.name ?? "Supplier"}` },
            unit_amount: Math.round(total * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.AIRSUP_URL}/projects/${(outreach as any).project_id}/paid`,
      metadata: {
        outreach_id: outreachId,
        project_id: (outreach as any).project_id,
      },
    });
    paymentLink = session.url ?? paymentLink;
  }

  await supabaseAdmin
    .from("projects")
    .update({ wa_status: "payment_pending" })
    .eq("id", (outreach as any).project_id);

  await supabaseAdmin
    .from("wa_outreach")
    .update({ status: "selected" })
    .eq("id", outreachId);

  if (buyer?.whatsapp_id) {
    await sendWhatsAppMessage(
      buyer.whatsapp_id,
      messages.buyer.paymentRequest(supplier?.name ?? "Supplier", sampleCost, commission, paymentLink)
    );
  }
}

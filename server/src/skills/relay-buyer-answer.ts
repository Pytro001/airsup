import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";

export async function relayBuyerAnswer({ questionId, answer }: { questionId: string; answer: string }) {
  const { data: bq } = await supabaseAdmin
    .from("buyer_questions")
    .select("*, wa_outreach(*, factories(*))")
    .eq("id", questionId)
    .single();

  if (!bq) return;

  await supabaseAdmin
    .from("buyer_questions")
    .update({ status: "answered", buyer_answer: answer, answered_at: new Date().toISOString() })
    .eq("id", questionId);

  const outreach = (bq as any).wa_outreach;
  const supplier = outreach?.factories;

  if (supplier?.whatsapp_id) {
    await sendWhatsAppMessage(supplier.whatsapp_id, messages.supplier.buyerAnswerRelay(answer));
  }

  // Resume outreach status
  if (outreach) {
    await supabaseAdmin
      .from("wa_outreach")
      .update({ status: "sent", last_message_at: new Date().toISOString() })
      .eq("id", outreach.id);
  }
}

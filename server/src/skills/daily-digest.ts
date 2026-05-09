import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";

export async function dailyDigest() {
  const { data: pending } = await supabaseAdmin
    .from("buyer_questions")
    .select("*, projects(*, profiles!projects_user_id_fkey(*))")
    .eq("status", "pending")
    .eq("urgency", "normal");

  if (!pending?.length) return;

  // Group by buyer phone
  const grouped: Record<string, any[]> = {};
  for (const q of pending) {
    const phone = (q.projects as any)?.profiles?.whatsapp_id;
    if (!phone) continue;
    if (!grouped[phone]) grouped[phone] = [];
    grouped[phone].push(q);
  }

  for (const [phone, questions] of Object.entries(grouped)) {
    const items = questions.map((q) => `${q.question} (${q.reason_for_escalating})`);
    await sendWhatsAppMessage(phone, messages.buyer.dailyDigest(items));

    await supabaseAdmin
      .from("buyer_questions")
      .update({ status: "asked", asked_at: new Date().toISOString() })
      .in("id", questions.map((q) => q.id));
  }
}

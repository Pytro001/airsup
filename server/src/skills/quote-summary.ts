import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";

export async function quoteSummary({ outreachId }: { outreachId: string }) {
  const { data: outreach } = await supabaseAdmin
    .from("wa_outreach")
    .select("*, factories(*), projects(*, profiles!projects_user_id_fkey(*))")
    .eq("id", outreachId)
    .single();

  if (!outreach) return;

  const buyer = (outreach.projects as any)?.profiles;
  const supplier = (outreach as any).factories;

  if (buyer?.whatsapp_id) {
    await sendWhatsAppMessage(
      buyer.whatsapp_id,
      messages.buyer.quoteSummary(
        supplier?.name ?? "Supplier",
        `${outreach.sample_cost} EUR`,
        `${outreach.bulk_price} EUR`,
        outreach.bulk_qty ?? 0,
        outreach.lead_time_days ?? 0
      )
    );
  }

  await supabaseAdmin
    .from("projects")
    .update({ wa_status: "quoting" })
    .eq("id", (outreach as any).project_id);
}

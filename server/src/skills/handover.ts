import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";

export async function handover({ outreachId }: { outreachId: string }) {
  const { data: outreach } = await supabaseAdmin
    .from("wa_outreach")
    .select("*, factories(*), projects(*, profiles!projects_user_id_fkey(*), user_settings(*))")
    .eq("id", outreachId)
    .single();

  if (!outreach) return;

  const buyer = (outreach.projects as any)?.profiles;
  const settings = (outreach.projects as any)?.user_settings?.[0];
  const supplier = (outreach as any).factories;
  const contactInfo = supplier?.contact_info ?? {};

  const supplierContact = [
    supplier?.whatsapp_id,
    contactInfo.email ?? contactInfo.contact_email,
  ]
    .filter(Boolean)
    .join(" / ");

  const buyerContact = [buyer?.whatsapp_id, settings?.email].filter(Boolean).join(" / ");

  if (supplier?.whatsapp_id) {
    await sendWhatsAppMessage(
      supplier.whatsapp_id,
      messages.supplier.handover(buyer?.display_name ?? "The buyer", buyerContact)
    );
  }

  if (buyer?.whatsapp_id) {
    await sendWhatsAppMessage(
      buyer.whatsapp_id,
      messages.buyer.handover(supplier?.name ?? "Supplier", supplierContact)
    );
  }

  await supabaseAdmin
    .from("projects")
    .update({ wa_status: "handed_over" })
    .eq("id", (outreach as any).project_id);

  await supabaseAdmin
    .from("wa_outreach")
    .update({ status: "handed_over" })
    .eq("id", outreachId);
}

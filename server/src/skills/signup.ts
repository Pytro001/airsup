import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";
import { triggerSkill } from "./runner.js";

export async function signup({ projectId, buyerId }: { projectId: string; buyerId: string }) {
  const { data: buyer } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .eq("id", buyerId)
    .single();
  if (!buyer?.whatsapp_id) return;

  await sendWhatsAppMessage(buyer.whatsapp_id, messages.buyer.signup());
  await supabaseAdmin
    .from("projects")
    .update({ wa_status: "understanding" })
    .eq("id", projectId);

  // Brief delay before sending the understand-and-confirm message
  setTimeout(() => {
    triggerSkill("understand-and-confirm", { projectId });
  }, 30_000);
}

import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";

export async function sendStatus({ projectId, buyer }: { projectId: string; buyer: any }) {
  const { data: project } = await supabaseAdmin
    .from("projects")
    .select("wa_status")
    .eq("id", projectId)
    .single();

  const { data: outreach } = await supabaseAdmin
    .from("wa_outreach")
    .select("status, factories(name), last_message_at")
    .eq("project_id", projectId)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const stage = project?.wa_status ?? "unknown";
  const supplierStatus = outreach ? `${(outreach as any).factories?.name} — ${outreach.status}` : "none yet";
  const lastUpdate = outreach?.last_message_at
    ? new Date(outreach.last_message_at).toLocaleDateString("en-GB")
    : "n/a";
  const nextStep =
    stage === "understanding" ? "waiting for your confirmation"
    : stage === "sourcing" ? "researching suppliers"
    : stage === "outreach" ? "waiting for supplier reply"
    : stage === "quoting" ? "waiting for your decision on the quote"
    : stage === "payment_pending" ? "waiting for payment"
    : "in progress";

  if (buyer?.whatsapp_id) {
    await sendWhatsAppMessage(
      buyer.whatsapp_id,
      messages.buyer.statusCheck(stage, supplierStatus, lastUpdate, nextStep)
    );
  }
}

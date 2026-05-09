import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { callClaude } from "../lib/claude.js";
import { messages } from "../lib/messages.js";

export async function outreach({
  projectId,
  supplierId,
  componentId,
}: {
  projectId: string;
  supplierId: number;
  componentId?: string;
}) {
  const { data: project } = await supabaseAdmin
    .from("projects")
    .select("*, profiles!projects_user_id_fkey(*), project_knowledge(*)")
    .eq("id", projectId)
    .single();

  const { data: supplier } = await supabaseAdmin
    .from("factories")
    .select("*")
    .eq("id", supplierId)
    .single();

  if (!project || !supplier) return;

  const buyer = (project as any).profiles;
  const knowledge = (project as any).project_knowledge ?? [];
  const brief = (project as any).brief_raw || (project as any).description || "";
  const lang = supplier.preferred_language || "en";

  const projectBrief = await callClaude({
    model: "claude-sonnet-4-6",
    system: `Write a concise project brief for a factory${lang !== "en" ? ` in ${lang}` : ""}. Include: product, quantity, key specs, critical requirements. 200 words max. Plain text, no formatting.`,
    messages: [
      {
        role: "user",
        content: `Project: ${brief}\n\nKnowledge:\n${knowledge.map((k: any) => k.content).join("\n")}`,
      },
    ],
    expectJSON: false,
  });

  const { data: record } = await supabaseAdmin
    .from("wa_outreach")
    .insert({
      project_id: projectId,
      component_id: componentId ?? null,
      supplier_id: supplierId,
      status: "sent",
      last_message_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (supplier.whatsapp_id) {
    await sendWhatsAppMessage(
      supplier.whatsapp_id,
      messages.supplier.outreach(buyer?.display_name ?? "A buyer", projectBrief)
    );
  }

  if (buyer?.whatsapp_id) {
    await sendWhatsAppMessage(buyer.whatsapp_id, messages.buyer.supplierFound(supplier.name));
  }

  await supabaseAdmin.from("projects").update({ wa_status: "outreach" }).eq("id", projectId);

  return record;
}

import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";
import { triggerSkill } from "./runner.js";

export async function kickoffResearch({ projectId }: { projectId: string }) {
  const { data: project } = await supabaseAdmin
    .from("projects")
    .select("*, profiles!projects_user_id_fkey(*)")
    .eq("id", projectId)
    .single();
  if (!project) return;

  const buyer = (project as any).profiles;
  await supabaseAdmin.from("projects").update({ wa_status: "sourcing" }).eq("id", projectId);

  if (buyer?.whatsapp_id) {
    await sendWhatsAppMessage(buyer.whatsapp_id, messages.buyer.researchStarted());
  }

  const candidates: any[] = await triggerSkill("match", { projectId }) ?? [];

  if (candidates.length === 0) {
    console.warn(`[kickoff-research] No candidates for project ${projectId} — needs manual supplier entry`);
    return;
  }

  return triggerSkill("outreach", { projectId, supplierId: candidates[0].id });
}

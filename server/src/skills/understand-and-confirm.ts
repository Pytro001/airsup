import { supabaseAdmin } from "../services/supabase.js";
import { sendWhatsAppMessage } from "../services/whatsapp.js";
import { messages } from "../lib/messages.js";
import { callClaude } from "../lib/claude.js";

export async function understandAndConfirm({ projectId }: { projectId: string }) {
  const { data: project } = await supabaseAdmin
    .from("projects")
    .select("*, profiles!projects_user_id_fkey(*), project_knowledge(*)")
    .eq("id", projectId)
    .single();
  if (!project) return;

  const buyer = (project as any).profiles;
  const knowledge = (project as any).project_knowledge ?? [];
  const brief = (project as any).brief_raw || (project as any).description || "";

  const summary = await callClaude({
    model: "claude-sonnet-4-6",
    system: `You are Supi, summarizing a project brief back to the buyer to confirm understanding before sourcing factories. Output one short paragraph in plain language, no bullets, no emojis. Reference the product, key specs, quantity, and any critical constraints. End with what components you think will need sourcing.`,
    messages: [
      {
        role: "user",
        content: `Project brief:\n${brief}\n\nUploaded files:\n${knowledge.filter((k: any) => k.type === "file").map((k: any) => k.content).join("\n\n")}`,
      },
    ],
    expectJSON: false,
  });

  if (buyer?.whatsapp_id) {
    await sendWhatsAppMessage(buyer.whatsapp_id, messages.buyer.understandAndConfirm(summary));
  }
}

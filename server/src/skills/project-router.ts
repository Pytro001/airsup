import { supabaseAdmin } from "../services/supabase.js";
import { triggerSkill } from "./runner.js";

function normalizePhone(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

async function loadProjectKnowledge(projectId: string) {
  const { data } = await supabaseAdmin
    .from("project_knowledge")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at");
  return data ?? [];
}

export async function projectRouter(message: {
  from: string;
  text: string;
  type: string;
  raw: any;
}) {
  const phone = normalizePhone(message.from);

  // Log every inbound message
  await supabaseAdmin.from("wa_messages").insert({
    direction: "inbound",
    whatsapp_number: phone,
    content: message.text,
    raw_payload: message.raw,
  });

  // Buyer lookup
  const { data: buyer } = await supabaseAdmin
    .from("profiles")
    .select("id, display_name, whatsapp_id, role")
    .eq("whatsapp_id", phone)
    .eq("role", "customer")
    .maybeSingle();

  if (buyer) {
    const { data: projects } = await supabaseAdmin
      .from("projects")
      .select("*")
      .eq("user_id", buyer.id)
      .neq("wa_status", "handed_over")
      .order("created_at", { ascending: false })
      .limit(1);

    const activeProject = projects?.[0];
    if (!activeProject) {
      console.log(`[Router] Buyer ${phone} has no active project`);
      return;
    }

    const knowledge = await loadProjectKnowledge(activeProject.id);
    return triggerSkill("handle-buyer-message", {
      buyer,
      project: activeProject,
      knowledge,
      message,
    });
  }

  // Supplier/factory lookup
  const { data: supplier } = await supabaseAdmin
    .from("factories")
    .select("*")
    .eq("whatsapp_id", phone)
    .maybeSingle();

  if (supplier) {
    const { data: outreach } = await supabaseAdmin
      .from("wa_outreach")
      .select("*, projects(*), project_components(*)")
      .eq("supplier_id", supplier.id)
      .in("status", ["sent", "replied_yes", "questions_pending"])
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!outreach) {
      console.log(`[Router] Supplier ${phone} has no active outreach`);
      return;
    }

    const knowledge = await loadProjectKnowledge((outreach.projects as any).id);
    return triggerSkill("reply-handler", {
      supplier,
      outreach,
      project: outreach.projects,
      knowledge,
      message,
    });
  }

  console.log(`[Router] Unknown sender: ${phone}`);
}

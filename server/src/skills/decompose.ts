import { supabaseAdmin } from "../services/supabase.js";
import { callClaude } from "../lib/claude.js";
import { triggerSkill } from "./runner.js";

export async function decompose({ projectId, carveOut }: { projectId: string; carveOut: string }) {
  const result = await callClaude({
    model: "claude-sonnet-4-6",
    system: `Identify the supplier category needed to source this part. Return JSON: {"category": "...", "spec": {}}`,
    messages: [{ role: "user", content: `Carve-out: ${carveOut}` }],
  });

  const { data: component } = await supabaseAdmin
    .from("project_components")
    .insert({
      project_id: projectId,
      name: carveOut,
      spec: result?.spec ?? {},
      status: "sourcing",
    })
    .select()
    .single();

  if (!component) return;

  const candidates: any[] = (await triggerSkill("match", {
    projectId,
    componentId: component.id,
  })) ?? [];

  if (candidates.length > 0) {
    return triggerSkill("outreach", {
      projectId,
      supplierId: candidates[0].id,
      componentId: component.id,
    });
  }

  console.warn(`[decompose] No candidates for carve-out "${carveOut}" on project ${projectId}`);
}

import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

export async function runNegotiation(outreachId: string): Promise<void> {
  const { data: outreach } = await supabaseAdmin
    .from("outreach_logs")
    .select(`
      id, factory_id, stage, ai_messages, outcome,
      factory_searches!inner(project_id, projects(title, description, requirements, ai_summary, user_id, companies(name)))
    `)
    .eq("id", outreachId)
    .single();

  if (!outreach || outreach.stage === "accepted" || outreach.stage === "rejected") return;

  const search = (outreach as any).factory_searches;
  const project = search?.projects;
  if (!project) return;

  const { data: factory } = await supabaseAdmin
    .from("factories")
    .select("*")
    .eq("id", outreach.factory_id)
    .single();

  if (!factory) return;

  const anthropic = getAnthropicClient();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: `You are negotiating with a factory on behalf of a buyer. Your goal is to:
1. Confirm the factory can handle the project
2. Get a preliminary quote (unit price, total, timeline)
3. Identify any concerns or deal-breakers
4. Determine if this is a good match

Respond with JSON:
{
  "can_handle": true/false,
  "quote": { "unit_price": "...", "total_estimate": "...", "lead_time": "...", "moq": "..." },
  "concerns": ["..."],
  "recommendation": "proceed" | "maybe" | "pass",
  "next_message_to_factory": "...",
  "summary_for_buyer": "..."
}`,
    messages: [
      {
        role: "user",
        content: `## Project for ${project.companies?.name || "buyer"}
${project.title}: ${project.description}
Requirements: ${JSON.stringify(project.requirements)}
Summary: ${JSON.stringify(project.ai_summary || {})}

## Factory: ${factory.name}
Location: ${factory.location}
Category: ${factory.category}
Capabilities: ${JSON.stringify(factory.capabilities)}
Contact: ${JSON.stringify(factory.contact_info)}

## Previous conversation
${JSON.stringify(outreach.ai_messages || [])}

Negotiate and provide your assessment.`,
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  let result;
  try {
    result = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim());
  } catch {
    result = { can_handle: false, recommendation: "maybe", summary_for_buyer: text };
  }

  const messages = [...(outreach.ai_messages || []), { role: "negotiator", content: result }];
  let newStage = outreach.stage;

  if (result.recommendation === "proceed" && result.can_handle) {
    newStage = "quoted";
  } else if (result.recommendation === "pass") {
    newStage = "rejected";
  } else {
    newStage = "negotiating";
  }

  await supabaseAdmin.from("outreach_logs").update({
    stage: newStage,
    ai_messages: messages,
    outcome: result.summary_for_buyer || outreach.outcome,
    updated_at: new Date().toISOString(),
  }).eq("id", outreachId);

  if (newStage === "quoted") {
    await supabaseAdmin.from("matches").insert({
      project_id: search.project_id,
      factory_id: outreach.factory_id,
      quote: result.quote || {},
      status: "pending",
      context_summary: {
        short: result.summary_for_buyer || "",
        factory_capabilities: factory.capabilities,
        recommendation: result.recommendation,
        concerns: result.concerns,
      },
    });

    await supabaseAdmin.from("projects").update({
      status: "matched",
      updated_at: new Date().toISOString(),
    }).eq("id", search.project_id);
  }
}

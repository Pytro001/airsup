import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

export async function runNegotiation(outreachId: string): Promise<void> {
  const { data: outreach } = await supabaseAdmin
    .from("outreach_logs")
    .select(`
      id, factory_id, stage, ai_messages, outcome,
      factory_searches!inner(project_id, projects(title, description, requirements, ai_summary, user_id, companies(name, description, industry, location, ai_knowledge)))
    `)
    .eq("id", outreachId)
    .single();

  if (
    !outreach ||
    outreach.stage === "accepted" ||
    outreach.stage === "rejected" ||
    outreach.stage === "await_supplier"
  ) {
    return;
  }

  const search = (outreach as any).factory_searches;
  const project = search?.projects;
  if (!project) return;

  const { data: factory } = await supabaseAdmin
    .from("factories")
    .select("*")
    .eq("id", outreach.factory_id)
    .single();

  if (!factory) return;

  const rawCo = project.companies as
    | { name?: string; description?: string; industry?: string; location?: string; ai_knowledge?: Record<string, unknown> }
    | { name?: string; description?: string; industry?: string; location?: string; ai_knowledge?: Record<string, unknown> }[]
    | undefined;
  const co = Array.isArray(rawCo) ? rawCo[0] : rawCo;
  const akLines =
    co?.ai_knowledge && typeof co.ai_knowledge === "object"
      ? Object.entries(co.ai_knowledge)
          .slice(0, 10)
          .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("\n")
      : "";
  const buyerCompanyBlock = `## Buyer company
Name: ${co?.name || "Unknown"}
Location: ${co?.location || "—"}
About: ${co?.description || "—"}
Sector: ${co?.industry || "—"}
${akLines ? `Other notes:\n${akLines}` : ""}`;

  const anthropic = getAnthropicClient();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: `You are negotiating with a factory on behalf of a buyer. Your goal is to:
1. Confirm the factory can handle the project
2. Get a preliminary quote (unit price, total, timeline)
3. Negotiate iteration terms — how many free/included design iterations, turnaround for first drawing or sample
4. Identify the specific designer or engineer who will work on this project (NOT a sales person)
5. Identify any concerns or deal-breakers
6. Determine if this is a good match

Key philosophy: we eliminate the sales middleman. The buyer will work directly with the factory's designer/engineer. The AI provides all context. Prioritize factories that offer:
- Fast first-iteration turnaround (first drawing, CAD, or sample)
- Free or included iteration rounds
- Direct access to the technical person doing the work

Respond with JSON:
{
  "can_handle": true/false,
  "quote": { "unit_price": "...", "total_estimate": "...", "lead_time": "...", "moq": "..." },
  "iteration_terms": { "free_iterations": "...", "first_deliverable": "...", "first_deliverable_timeline": "..." },
  "direct_contact": { "name": "...", "role": "...", "department": "..." },
  "concerns": ["..."],
  "recommendation": "proceed" | "maybe" | "pass",
  "next_message_to_factory": "...",
  "summary_for_buyer": "..."
}`,
    messages: [
      {
        role: "user",
        content: `${buyerCompanyBlock}

## Project for buyer
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
    newStage = "await_supplier";
  } else if (result.recommendation === "pass") {
    newStage = "rejected";
  } else {
    newStage = "negotiating";
  }

  const pendingMatch =
    newStage === "await_supplier"
      ? {
          project_id: search.project_id,
          factory_id: outreach.factory_id,
          quote: { ...(result.quote || {}), iteration_terms: result.iteration_terms },
          context_summary: {
            short: result.summary_for_buyer || "",
            factory_capabilities: factory.capabilities,
            recommendation: result.recommendation,
            concerns: result.concerns,
            direct_contact: result.direct_contact,
            iteration_terms: result.iteration_terms,
          },
        }
      : null;

  await supabaseAdmin.from("outreach_logs").update({
    stage: newStage,
    ai_messages: messages,
    outcome: result.summary_for_buyer || outreach.outcome,
    pending_match: pendingMatch,
    updated_at: new Date().toISOString(),
  }).eq("id", outreachId);
}

import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

export async function processMatch(matchId: string): Promise<void> {
  const { data: match } = await supabaseAdmin
    .from("matches")
    .select(`
      id, status, quote, context_summary,
      projects(id, title, description, requirements, ai_summary, user_id,
        companies(name)),
      factories(id, name, location, category, capabilities, contact_info)
    `)
    .eq("id", matchId)
    .single();

  if (!match || match.status !== "pending") return;

  const project = (match as any).projects;
  const factory = (match as any).factories;
  if (!project || !factory) return;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("display_name")
    .eq("id", project.user_id)
    .single();

  const anthropic = getAnthropicClient();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    system: `Generate a concise context summary and next steps for a buyer-to-engineer introduction. This is NOT a sales introduction — the buyer is being connected directly to the designer or engineer at the factory who will work on their product.

The AI has already briefed the factory's technical team with full project context, so the engineer can start working immediately. The goal is fast iteration — getting a first drawing, design, or sample back quickly.

Respond with JSON: { "summary": "...", "next_steps": "...", "key_context_for_buyer": "...", "key_context_for_engineer": "...", "first_deliverable": "...", "expected_turnaround": "..." }

- key_context_for_engineer: everything the engineer needs to start working (specs, materials, quantities, constraints, design files mentioned)
- first_deliverable: what the buyer should expect first (e.g. "initial CAD drawing", "pattern sample", "3D render")
- expected_turnaround: when the buyer can expect the first deliverable`,
    messages: [
      {
        role: "user",
        content: `Project: ${project.title} — ${project.description}
Requirements: ${JSON.stringify(project.requirements)}
Company: ${project.companies?.name || "Buyer"}
Factory: ${factory.name} in ${factory.location} (${factory.category})
Capabilities: ${JSON.stringify(factory.capabilities)}
Quote: ${JSON.stringify(match.quote)}

Generate the introduction context.`,
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  let intro;
  try {
    intro = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim());
  } catch {
    intro = { summary: text, next_steps: "Discuss details directly with the engineer.", key_context_for_buyer: "", key_context_for_engineer: "", first_deliverable: "", expected_turnaround: "" };
  }

  await supabaseAdmin.from("matches").update({
    status: "intro_sent",
    context_summary: {
      short: intro.summary,
      next_steps: intro.next_steps,
      buyer_context: intro.key_context_for_buyer,
      engineer_context: intro.key_context_for_engineer,
      first_deliverable: intro.first_deliverable,
      expected_turnaround: intro.expected_turnaround,
    },
  }).eq("id", matchId);

  const introMsg = `Great news! I found a match for "${project.title}":\n\n**${factory.name}** (${factory.location})\n\n${intro.summary}\n\nQuote: ${match.quote?.unit_price || "See details"} per unit, ${match.quote?.lead_time || "TBD"} lead time.${intro.first_deliverable ? `\n\nFirst deliverable: ${intro.first_deliverable}${intro.expected_turnaround ? ` (${intro.expected_turnaround})` : ""}` : ""}\n\nYou'll be working directly with their designer/engineer — no sales middleman. ${intro.next_steps}\n\nHead to the **Connections** tab to start chatting with them directly.`;

  await supabaseAdmin.from("conversations").insert({
    user_id: project.user_id,
    project_id: project.id,
    role: "assistant",
    content: introMsg,
    metadata: {
      action: { action: "navigate", target: "connections", label: "Go to Connections" },
    },
  });

  if (intro.key_context_for_engineer) {
    const { data: factoryRecord } = await supabaseAdmin
      .from("factories")
      .select("user_id")
      .eq("id", factory.id)
      .single();

    if (factoryRecord?.user_id) {
      await supabaseAdmin.from("connection_messages").insert({
        match_id: matchId,
        sender_id: project.user_id,
        content: `[Airsup AI] Introduction: ${intro.summary}\n\nProject: ${project.title}\nCompany: ${project.companies?.name || "Buyer"}\n\n${intro.key_context_for_engineer}\n\nFirst deliverable expected: ${intro.first_deliverable || "To be discussed"}`,
      });
    }
  }
}

import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

export async function runFactorySearch(searchId: string): Promise<void> {
  const { data: search } = await supabaseAdmin
    .from("factory_searches")
    .select("id, project_id, search_criteria, status")
    .eq("id", searchId)
    .single();

  if (!search || search.status !== "pending") return;

  await supabaseAdmin.from("factory_searches").update({ status: "in_progress" }).eq("id", searchId);

  const { data: project } = await supabaseAdmin
    .from("projects")
    .select("title, description, requirements, ai_summary, user_id, companies(name, industry, ai_knowledge)")
    .eq("id", search.project_id)
    .single();

  if (!project) {
    await supabaseAdmin.from("factory_searches").update({ status: "failed" }).eq("id", searchId);
    return;
  }

  const criteria = search.search_criteria || {};
  let query = supabaseAdmin.from("factories").select("*").eq("active", true);
  if (criteria.category) query = query.ilike("category", `%${criteria.category}%`);
  if (criteria.location_preference) query = query.ilike("location", `%${criteria.location_preference}%`);

  const { data: candidates } = await query.limit(20);

  if (!candidates?.length) {
    await supabaseAdmin.from("factory_searches").update({ status: "completed" }).eq("id", searchId);
    return;
  }

  const anthropic = getAnthropicClient();

  for (const factory of candidates) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: `You are an expert manufacturing sourcing analyst. Evaluate whether a factory is a good potential match for a sourcing project. Respond with JSON: { "match_score": 0-100, "reasoning": "...", "suggested_brief": "..." }. The suggested_brief should be a 2-3 sentence summary you would send to the factory to introduce the project.`,
        messages: [
          {
            role: "user",
            content: `## Project
Title: ${project.title}
Description: ${project.description}
Requirements: ${JSON.stringify(project.requirements)}
AI Summary: ${JSON.stringify(project.ai_summary || {})}
Company: ${(project as any).companies?.name || "Unknown"} (${(project as any).companies?.industry || "Unknown"})

## Factory Candidate
Name: ${factory.name}
Location: ${factory.location}
Category: ${factory.category}
Capabilities: ${JSON.stringify(factory.capabilities)}

Evaluate the match.`,
          },
        ],
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      let evaluation;
      try {
        evaluation = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim());
      } catch {
        evaluation = { match_score: 50, reasoning: text, suggested_brief: "" };
      }

      if (evaluation.match_score >= 60) {
        await supabaseAdmin.from("outreach_logs").insert({
          search_id: searchId,
          factory_id: factory.id,
          stage: "briefed",
          ai_messages: [
            { role: "system", content: "Match evaluation", evaluation },
            { role: "assistant", content: evaluation.suggested_brief },
          ],
          outcome: `Score: ${evaluation.match_score}/100`,
        });
      }
    } catch (err) {
      console.error(`[Airsup] search eval error for factory ${factory.id}:`, err);
    }
  }

  await supabaseAdmin.from("factory_searches").update({ status: "completed" }).eq("id", searchId);
}

import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";
import { criteriaHasSearchSignals, type SearchCriteria } from "../lib/search-criteria.js";

const MAX_CANDIDATES_FETCH = 40;
const MAX_FACTORIES_TO_SCORE = 12;

function sanitizeIlikeToken(s: string): string {
  return s.replace(/[^a-zA-Z0-9\s\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
}

function buildOrFilterParts(criteria: SearchCriteria): string[] {
  const parts: string[] = [];
  const addTerm = (raw: string | undefined) => {
    const t = sanitizeIlikeToken(raw || "");
    if (t.length < 2) return;
    const v = `%${t}%`;
    parts.push(`category.ilike.${v}`);
    parts.push(`name.ilike.${v}`);
    parts.push(`location.ilike.${v}`);
  };

  if (typeof criteria.category === "string") addTerm(criteria.category);
  if (typeof criteria.ideal_factory_profile === "string") addTerm(criteria.ideal_factory_profile);
  if (Array.isArray(criteria.keywords)) {
    for (const k of criteria.keywords.slice(0, 8)) addTerm(String(k));
  }
  return parts;
}

function titleFallbackKeywords(title: string): string[] {
  return sanitizeIlikeToken(title)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && w.length < 36)
    .slice(0, 5);
}

async function extractSearchHints(
  searchId: string,
  project: {
    title: string;
    description: string;
    requirements: Record<string, unknown> | null;
    ai_summary: Record<string, unknown> | null;
  },
  criteria: SearchCriteria
): Promise<SearchCriteria> {
  const anthropic = getAnthropicClient();
  const userBlock = `## Project
Title: ${project.title}
Description: ${project.description}
Requirements: ${JSON.stringify(project.requirements || {})}
AI summary: ${JSON.stringify(project.ai_summary || {})}

Respond with JSON only: { "category_guess": "short manufacturing category or process", "region_guess": "preferred region if any or empty string", "keywords": ["up to 8 lowercase single-word or short tokens for factory search, e.g. pcb, injection, apparel"] }`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
      system:
        "You output only valid JSON for manufacturing sourcing. category_guess is one short phrase (e.g. CNC machining, PCB assembly). keywords must be safe for database ilike (letters, numbers, hyphens; no quotes or commas inside tokens).",
      messages: [{ role: "user", content: userBlock }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    let parsed: { category_guess?: string; region_guess?: string; keywords?: string[] };
    try {
      parsed = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim()) as typeof parsed;
    } catch {
      return criteria;
    }
    const next: SearchCriteria = { ...criteria };
    if (parsed.category_guess && !next.category) next.category = sanitizeIlikeToken(parsed.category_guess).slice(0, 80);
    if (parsed.region_guess && !next.location_preference) {
      const r = sanitizeIlikeToken(parsed.region_guess);
      if (r.length >= 2) next.location_preference = r.slice(0, 80);
    }
    if (Array.isArray(parsed.keywords) && parsed.keywords.length) {
      const merged = new Set<string>([...(next.keywords || []).map(String), ...parsed.keywords.map((k) => String(k).toLowerCase().slice(0, 40))]);
      next.keywords = Array.from(merged).filter((k) => k.length > 1).slice(0, 12);
    }
    await supabaseAdmin.from("factory_searches").update({ search_criteria: next }).eq("id", searchId);
    return next;
  } catch (err) {
    console.error("[Airsup] extractSearchHints:", err);
    return criteria;
  }
}

function formatCompanyBlock(company: Record<string, unknown> | Record<string, unknown>[] | null | undefined): string {
  if (Array.isArray(company)) return formatCompanyBlock(company[0]);
  if (!company) return "Unknown";
  const name = String(company.name || "Unknown");
  const desc = String(company.description || "").trim();
  const ind = String(company.industry || "").trim();
  const loc = String(company.location || "").trim();
  const ak = company.ai_knowledge as Record<string, unknown> | undefined;
  let extra = "";
  if (ak && typeof ak === "object") {
    const entries = Object.entries(ak)
      .slice(0, 12)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    if (entries.length) extra = "\nNotes: " + entries.join("; ");
  }
  return `${name}${loc ? ` (${loc})` : ""}${desc ? `\nCompany: ${desc}` : ""}${ind ? `\nSector: ${ind}` : ""}${extra}`;
}

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
    .select("title, description, requirements, ai_summary, user_id, companies(name, industry, description, location, ai_knowledge)")
    .eq("id", search.project_id)
    .single();

  if (!project) {
    await supabaseAdmin.from("factory_searches").update({ status: "failed" }).eq("id", searchId);
    return;
  }

  let criteria = { ...(search.search_criteria || {}) } as SearchCriteria;

  if (!criteriaHasSearchSignals(criteria)) {
    criteria = await extractSearchHints(searchId, project, criteria);
  }

  if (!criteriaHasSearchSignals(criteria)) {
    const fb = titleFallbackKeywords(project.title);
    criteria = { ...criteria, keywords: [...(criteria.keywords || []), ...fb].slice(0, 12) };
    await supabaseAdmin.from("factory_searches").update({ search_criteria: criteria }).eq("id", searchId);
  }

  let orParts = buildOrFilterParts(criteria);
  if (!orParts.length) {
    const fb = titleFallbackKeywords(project.title);
    criteria = { ...criteria, keywords: fb };
    orParts = buildOrFilterParts(criteria);
  }

  let query = supabaseAdmin.from("factories").select("*").eq("active", true);
  if (orParts.length) {
    query = query.or(orParts.join(","));
  }
  if (typeof criteria.location_preference === "string" && sanitizeIlikeToken(criteria.location_preference).length >= 2) {
    const locPat = `%${sanitizeIlikeToken(criteria.location_preference)}%`;
    query = query.ilike("location", locPat);
  }

  const { data: candidatesRaw } = await query.limit(MAX_CANDIDATES_FETCH);
  const candidates = (candidatesRaw || []).slice(0, MAX_FACTORIES_TO_SCORE);

  if (!candidates.length) {
    await supabaseAdmin.from("factory_searches").update({ status: "completed" }).eq("id", searchId);
    return;
  }

  const anthropic = getAnthropicClient();
  const company = (project as unknown as { companies?: Record<string, unknown> | Record<string, unknown>[] }).companies;
  const companyBlock = formatCompanyBlock(company);
  const req = project.requirements || {};
  const qtyHint = typeof req.quantity === "string" ? req.quantity : JSON.stringify(req.quantity || {});

  for (const factory of candidates) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: `You are an expert manufacturing sourcing analyst. Evaluate whether a factory is a good potential match for a sourcing project.

Key priority: we connect buyers DIRECTLY to the factory's designer or engineer — not sales staff. Evaluate whether this factory can provide direct technical contact for fast iteration. Factories with in-house design/engineering teams score higher.

Respond with JSON: { "match_score": 0-100, "reasoning": "...", "suggested_brief": "...", "ideal_contact_role": "..." }.
- suggested_brief: 2-3 sentences for the factory's technical team. MUST mention product type, quantity/timeline if known from requirements or AI summary, and what you need from them first (e.g. first CAD, sample, DFM). Not a sales pitch.
- ideal_contact_role: the specific role at the factory (e.g. "mechanical engineer", "mold designer").`,
        messages: [
          {
            role: "user",
            content: `## Buyer / project
Title: ${project.title}
Description: ${project.description}
Requirements (structured): ${JSON.stringify(project.requirements || {})}
Quantity / MOQ hint: ${qtyHint}
AI Summary: ${JSON.stringify(project.ai_summary || {})}

## Buyer company
${companyBlock}

## Factory candidate
Name: ${factory.name}
Location: ${factory.location}
Category: ${factory.category}
Capabilities: ${JSON.stringify(factory.capabilities)}

Evaluate the match.`,
          },
        ],
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      let evaluation: { match_score?: number; reasoning?: string; suggested_brief?: string; ideal_contact_role?: string };
      try {
        evaluation = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim());
      } catch {
        evaluation = { match_score: 50, reasoning: text, suggested_brief: "" };
      }

      const score = typeof evaluation.match_score === "number" ? evaluation.match_score : 50;

      if (score >= 60) {
        await supabaseAdmin.from("outreach_logs").insert({
          search_id: searchId,
          factory_id: factory.id,
          stage: "briefed",
          ai_messages: [
            { role: "system", content: "Match evaluation", evaluation },
            { role: "assistant", content: evaluation.suggested_brief },
          ],
          outcome: `Score: ${score}/100`,
        });
      }
    } catch (err) {
      console.error(`[Airsup] search eval error for factory ${factory.id}:`, err);
    }
  }

  await supabaseAdmin.from("factory_searches").update({ status: "completed" }).eq("id", searchId);
}

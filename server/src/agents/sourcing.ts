/**
 * Sourcing agent: find supplier candidates for a project.
 *
 * Strategy (token-saving by design):
 *   1. Look up matching suppliers in the platform's `factories` table first.
 *   2. Only if zero platform matches → call Claude with `web_search` restricted
 *      to jd.com and cantonfair.* (no general web).
 *
 * All results are written into `sourcing_candidates` with status 'pending' so
 * an admin can approve/reject before any outreach starts.
 */

import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

type Project = {
  id: string;
  title: string | null;
  description: string | null;
  requirements: Record<string, unknown> | null;
  ai_summary: Record<string, unknown> | null;
};

type FactoryRow = {
  id: number;
  name: string;
  location: string | null;
  category: string | null;
  capabilities: unknown;
};

type WebHit = {
  source: "jd" | "cantonfair";
  supplier_name: string;
  supplier_url: string;
  supplier_location?: string;
  reasoning: string;
  whatsapp?: string;
  phone?: string;
  wechat?: string;
};

const PLATFORM_LIMIT = 8;
const WEB_LIMIT = 6;
const MODEL = "claude-sonnet-4-20250514";

function sanitizeIlikeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\- ]/g, "").trim();
}

function extractKeywords(project: Project): string[] {
  const out = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const tokens = v
      .toLowerCase()
      .split(/[^a-z0-9\-]+/)
      .filter((t) => t.length >= 3 && t.length <= 30);
    for (const t of tokens) out.add(t);
  };
  push(project.title);
  push(project.description);
  if (project.requirements && typeof project.requirements === "object") {
    for (const v of Object.values(project.requirements)) push(typeof v === "string" ? v : JSON.stringify(v));
  }
  if (project.ai_summary && typeof project.ai_summary === "object") {
    for (const v of Object.values(project.ai_summary)) push(typeof v === "string" ? v : JSON.stringify(v));
  }
  return Array.from(out).slice(0, 10);
}

async function findPlatformMatches(project: Project): Promise<FactoryRow[]> {
  const keywords = extractKeywords(project);
  if (!keywords.length) {
    const { data } = await supabaseAdmin
      .from("factories")
      .select("id, name, location, category, capabilities")
      .eq("active", true)
      .limit(PLATFORM_LIMIT);
    return (data || []) as FactoryRow[];
  }

  const orParts: string[] = [];
  for (const kw of keywords.slice(0, 6)) {
    const safe = sanitizeIlikeToken(kw);
    if (!safe) continue;
    orParts.push(`name.ilike.%${safe}%`);
    orParts.push(`category.ilike.%${safe}%`);
    orParts.push(`capabilities::text.ilike.%${safe}%`);
  }

  let query = supabaseAdmin
    .from("factories")
    .select("id, name, location, category, capabilities")
    .eq("active", true);

  if (orParts.length) query = query.or(orParts.join(","));

  const { data } = await query.limit(PLATFORM_LIMIT);
  return (data || []) as FactoryRow[];
}

function buildSearchQuery(project: Project): string {
  const bits: string[] = [];
  if (project.title) bits.push(project.title);
  const reqs = project.requirements || {};
  for (const [k, v] of Object.entries(reqs)) {
    if (typeof v === "string" && v.length < 80) bits.push(`${k}: ${v}`);
  }
  if (!bits.length && project.description) bits.push(project.description.slice(0, 200));
  return bits.join(" — ").slice(0, 280);
}

async function searchWebForSuppliers(project: Project): Promise<WebHit[]> {
  const anthropic = getAnthropicClient();
  const query = buildSearchQuery(project);

  const requirementsBlock = JSON.stringify(project.requirements || {}, null, 2).slice(0, 1500);

  const system =
    "You are a manufacturing sourcing scout. You find Chinese factories that can produce a buyer's spec. " +
    "You ONLY search on JD.com and CantonFair (cantonfair.org.cn / cantonfair.net). " +
    "After searching, return up to 6 distinct supplier candidates. " +
    "For each supplier, visit their listing or company page and extract ALL of the following if visible:\n" +
    "  - source: 'jd' or 'cantonfair'\n" +
    "  - supplier_name: company name\n" +
    "  - supplier_url: the listing or company page URL\n" +
    "  - supplier_location: city/province\n" +
    "  - reasoning: 1-2 sentences explaining why this supplier fits the buyer spec\n" +
    "  - whatsapp: WhatsApp number in international format (e.g. +8613812345678) if listed on the page\n" +
    "  - phone: phone number in international format if listed and no WhatsApp\n" +
    "  - wechat: WeChat ID if listed\n\n" +
    "JD.com store pages often show contact numbers under '联系方式' or '客服'. " +
    "CantonFair exhibitor pages typically list WhatsApp/phone in the contact section. " +
    "Always try to find a contact number — it dramatically increases the buyer's ability to reach the factory. " +
    "Do NOT invent URLs or contact numbers. Omit fields you cannot confirm. If you cannot find any suppliers, return an empty array.\n\n" +
    "Respond ONLY as a JSON array of objects. No prose.";

  const user =
    `Project: ${project.title || "(untitled)"}\n` +
    `Description: ${(project.description || "").slice(0, 800)}\n` +
    `Requirements:\n${requirementsBlock}\n\n` +
    `Search query intent: ${query}`;

  try {
    // Anthropic server-side web_search tool with domain allowlist.
    // SDK 0.39 may not have typings yet, so cast via unknown.
    const webSearchTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 12,
      allowed_domains: ["jd.com", "cantonfair.org.cn", "cantonfair.net"],
    } as unknown;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 6000,
      system,
      tools: [webSearchTool] as Parameters<typeof anthropic.messages.create>[0]["tools"],
      messages: [{ role: "user", content: user }],
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    text = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    const out: WebHit[] = [];
    for (const row of parsed.slice(0, WEB_LIMIT)) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const src = String(r.source || "").toLowerCase();
      const source: "jd" | "cantonfair" =
        src.includes("canton") ? "cantonfair" : "jd";
      const name = String(r.supplier_name || "").trim();
      const url = String(r.supplier_url || "").trim();
      if (!name || !url) continue;

      const whatsapp = typeof r.whatsapp === "string" ? r.whatsapp.replace(/[^\d+]/g, "").slice(0, 20) : undefined;
      const phone = typeof r.phone === "string" ? r.phone.replace(/[^\d+\- ()]/g, "").slice(0, 30) : undefined;
      const wechat = typeof r.wechat === "string" ? r.wechat.trim().slice(0, 80) : undefined;

      out.push({
        source,
        supplier_name: name.slice(0, 200),
        supplier_url: url.slice(0, 600),
        supplier_location: typeof r.supplier_location === "string" ? r.supplier_location.slice(0, 120) : undefined,
        reasoning: typeof r.reasoning === "string" ? r.reasoning.slice(0, 800) : "",
        whatsapp: whatsapp || undefined,
        phone: phone || undefined,
        wechat: wechat || undefined,
      });
    }
    return out;
  } catch (err) {
    console.error("[Airsup] sourcing.searchWebForSuppliers:", err);
    return [];
  }
}

export type SourcingRunResult = {
  used_platform: boolean;
  used_web_search: boolean;
  candidate_count: number;
  reused_existing: number;
};

/**
 * Run sourcing for a project. Writes any new candidates to `sourcing_candidates`
 * with status 'pending'. Returns a brief summary.
 *
 * Idempotent enough: if there are already pending candidates for this project,
 * we skip the work and return them. Pass force=true to re-run anyway.
 */
export async function runSourcingForProject(projectId: string, opts: { force?: boolean } = {}): Promise<SourcingRunResult> {
  const force = !!opts.force;

  if (!force) {
    const { data: existing } = await supabaseAdmin
      .from("sourcing_candidates")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "pending");
    if (existing && existing.length) {
      return { used_platform: false, used_web_search: false, candidate_count: existing.length, reused_existing: existing.length };
    }
  }

  const { data: project, error: pErr } = await supabaseAdmin
    .from("projects")
    .select("id, title, description, requirements, ai_summary")
    .eq("id", projectId)
    .single();

  if (pErr || !project) {
    throw new Error(pErr?.message || "Project not found");
  }
  const proj = project as Project;

  // Step 1: platform-first.
  const platformHits = await findPlatformMatches(proj);

  let inserted = 0;

  if (platformHits.length) {
    const rows = platformHits.map((f) => ({
      project_id: projectId,
      source: "platform" as const,
      factory_id: f.id,
      supplier_url: null,
      supplier_name: f.name,
      supplier_location: f.location,
      reasoning: `Platform match — category "${f.category || "n/a"}". Reusing existing onboarded factory; no web research needed.`,
      raw: { capabilities: f.capabilities },
      status: "pending" as const,
    }));
    const { data: ins, error: iErr } = await supabaseAdmin
      .from("sourcing_candidates")
      .insert(rows)
      .select("id");
    if (iErr) throw new Error(iErr.message);
    inserted = ins?.length || 0;
    return { used_platform: true, used_web_search: false, candidate_count: inserted, reused_existing: 0 };
  }

  // Step 2: web search fallback.
  const webHits = await searchWebForSuppliers(proj);
  if (!webHits.length) {
    return { used_platform: true, used_web_search: true, candidate_count: 0, reused_existing: 0 };
  }

  const rows = webHits.map((h) => ({
    project_id: projectId,
    source: h.source,
    factory_id: null,
    supplier_url: h.supplier_url,
    supplier_name: h.supplier_name,
    supplier_location: h.supplier_location || null,
    reasoning: h.reasoning,
    raw: {
      ...(h.whatsapp ? { whatsapp: h.whatsapp } : {}),
      ...(h.phone ? { phone: h.phone } : {}),
      ...(h.wechat ? { wechat: h.wechat } : {}),
    },
    status: "pending" as const,
  }));

  const { data: ins, error: iErr } = await supabaseAdmin
    .from("sourcing_candidates")
    .insert(rows)
    .select("id");
  if (iErr) throw new Error(iErr.message);
  inserted = ins?.length || 0;

  return { used_platform: true, used_web_search: true, candidate_count: inserted, reused_existing: 0 };
}

/**
 * Approve a sourcing candidate:
 *  - if it's a 'platform' candidate → create a `matches` row to its factory_id.
 *  - if it's a 'jd' or 'cantonfair' candidate → create a placeholder `factories` row
 *    (no user_id yet, active=false until they onboard) and a `matches` row to it.
 *
 * The placeholder factory becomes a real onboardable supplier when admin/Supi
 * reaches out and the factory team accepts the brief.
 */
export async function approveSourcingCandidate(candidateId: string): Promise<{ match_id: string; factory_id: number }> {
  const { data: cand, error: cErr } = await supabaseAdmin
    .from("sourcing_candidates")
    .select("*")
    .eq("id", candidateId)
    .single();

  if (cErr || !cand) throw new Error(cErr?.message || "Candidate not found");
  if (cand.status !== "pending") throw new Error("Candidate already decided");

  let factoryId = cand.factory_id as number | null;

  if (!factoryId) {
    const rawData = (cand.raw && typeof cand.raw === "object") ? cand.raw as Record<string, unknown> : {};
    const inserted = await supabaseAdmin
      .from("factories")
      .insert({
        name: cand.supplier_name,
        location: cand.supplier_location || "",
        category: "",
        capabilities: {},
        contact_info: {
          source: cand.source,
          source_url: cand.supplier_url,
          ...(rawData.whatsapp ? { whatsapp: rawData.whatsapp } : {}),
          ...(rawData.phone ? { phone: rawData.phone } : {}),
          ...(rawData.wechat ? { wechat: rawData.wechat } : {}),
        },
        ...(rawData.whatsapp ? { whatsapp_id: rawData.whatsapp } : {}),
        active: false,
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || "Failed to create factory placeholder");
    factoryId = inserted.data.id as number;
  }

  // Avoid duplicate matches.
  const { data: existing } = await supabaseAdmin
    .from("matches")
    .select("id")
    .eq("project_id", cand.project_id)
    .eq("factory_id", factoryId)
    .maybeSingle();

  let matchId: string;
  if (existing?.id) {
    matchId = existing.id as string;
  } else {
    const inserted = await supabaseAdmin
      .from("matches")
      .insert({
        project_id: cand.project_id,
        factory_id: factoryId,
        status: "pending",
        quote: {},
        context_summary: { source: "sourcing", origin: cand.source, supplier_url: cand.supplier_url, reasoning: cand.reasoning },
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) throw new Error(inserted.error?.message || "Failed to create match");
    matchId = inserted.data.id as string;
  }

  await supabaseAdmin
    .from("sourcing_candidates")
    .update({ status: "approved", decided_at: new Date().toISOString() })
    .eq("id", candidateId);

  return { match_id: matchId, factory_id: factoryId };
}

export async function rejectSourcingCandidate(candidateId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("sourcing_candidates")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", candidateId);
  if (error) throw new Error(error.message);
}

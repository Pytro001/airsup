import { getAnthropicClient } from "../services/anthropic.js";

export type ImportedBrief = {
  title: string;
  description: string;
  product_type: string | null;
  materials: string | null;
  quantity: string | null;
  timeline: string | null;
  quality_requirements: string | null;
  additional_notes: string | null;
  ideal_factory_profile: string | null;
  budget: string | null;
  readiness: "low" | "medium" | "high";
  key_requirements: string[];
};

const MODEL = "claude-sonnet-4-20250514";

/**
 * Turn raw conversation (from a share page or paste) into a structured manufacturing brief.
 */
export async function importBriefFromText(raw: string, _userId: string): Promise<ImportedBrief> {
  const anthropic = getAnthropicClient();
  const trimmed = raw.slice(0, 200_000);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: `You extract a manufacturing / sourcing project brief from a conversation between a founder and a general-purpose AI (ChatGPT, Claude, Grok, etc.).

Output a single JSON object with these keys only (use null for unknown strings, [] for key_requirements if none):
- title: short project name (5-8 words)
- description: 2-4 sentences: what to build, key constraints, stage (idea / prototype)
- product_type: e.g. "CNC parts", "injection molding", "apparel" — one short phrase or null
- materials: or null
- quantity: or null; do not invent; prototype/small run is fine as text
- timeline: or null; do not guess dates
- quality_requirements: certifications, IP, quality — or null
- additional_notes: anything else important — or null
- ideal_factory_profile: what kind of factory or process fits — or null
- budget: if mentioned, else null
- readiness: one of "low" | "medium" | "high" based on how complete the brief is
- key_requirements: array of up to 8 short strings (must-haves)

Rules: Never invent MOQ, deadlines, or budget. If the chat is not about a product, still extract the best possible manufacturing-sourcing summary from what is there.`,
    messages: [{ role: "user", content: `Conversation / notes:\n\n${trimmed}` }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return fallbackBrief(trimmed);
  }

  return normalizeBrief(parsed, trimmed);
}

function fallbackBrief(raw: string): ImportedBrief {
  const title = (raw.split(/\n/)[0] || "Sourcing project").trim().slice(0, 120);
  return {
    title: title || "Sourcing project",
    description: raw.trim().slice(0, 2000),
    product_type: null,
    materials: null,
    quantity: null,
    timeline: null,
    quality_requirements: null,
    additional_notes: null,
    ideal_factory_profile: null,
    budget: null,
    readiness: "low",
    key_requirements: [],
  };
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function normalizeBrief(parsed: Record<string, unknown>, raw: string): ImportedBrief {
  const keyReq = parsed.key_requirements;
  const keys: string[] = Array.isArray(keyReq)
    ? (keyReq as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
    : [];

  let readiness: "low" | "medium" | "high" = "medium";
  const r = String(parsed.readiness || "").toLowerCase();
  if (r === "low" || r === "high" || r === "medium") readiness = r;

  return {
    title: asStr(parsed.title) || "Sourcing project",
    description: asStr(parsed.description) || raw.slice(0, 2000).trim() || "Manufacturing project",
    product_type: asStr(parsed.product_type),
    materials: asStr(parsed.materials),
    quantity: asStr(parsed.quantity),
    timeline: asStr(parsed.timeline),
    quality_requirements: asStr(parsed.quality_requirements),
    additional_notes: asStr(parsed.additional_notes),
    ideal_factory_profile: asStr(parsed.ideal_factory_profile),
    budget: asStr(parsed.budget),
    readiness,
    key_requirements: keys,
  };
}

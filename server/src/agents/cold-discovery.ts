/**
 * Cold discovery agent: find new factories/suppliers in CN/US/EU across categories
 * we serve (medical, furniture, cosmetics, hardware, clothing, packaging, electronics).
 *
 * Inserts into `cold_targets` with status='discovered'. The quality agent runs next.
 */

import { getOpenAIClient, MODEL_HEAVY } from "../services/openai.js";
import { supabaseAdmin } from "../services/supabase.js";

export const CATEGORIES = [
  "medical-devices",
  "furniture",
  "cosmetics-packaging",
  "hardware-tools",
  "consumer-electronics",
  "apparel-textiles",
  "packaging",
  "industrial-components",
  "kitchenware",
  "toys-games",
] as const;

export const REGIONS = ["CN", "US", "EU"] as const;
export type Region = (typeof REGIONS)[number];

type Hit = {
  company_name: string;
  website: string;
  email?: string;
  contact_name?: string;
  country?: string;
  reasoning?: string;
};

async function discoverOne(category: string, region: Region): Promise<Hit[]> {
  const client = getOpenAIClient();

  const regionHint =
    region === "CN" ? "in China (Guangdong, Zhejiang, Jiangsu, Shanghai, Shandong)"
    : region === "US" ? "in the United States"
    : "in the European Union (Germany, Italy, Poland, Portugal, Czech Republic)";

  const system =
    "You research and shortlist real manufacturers/suppliers that B2B buyers would actually want to work with. " +
    "You only return suppliers whose own website is in English (or has a working English version), shows a modern professional design, and lists named customers/brands they have produced for. " +
    "You skip Alibaba storefronts, Made-in-China.com pages, and trading-company resellers. Direct manufacturer websites only. " +
    "For each supplier you return: company_name, website (root URL), email (the actual contact or sales email visible on their site), country, contact_name if available, " +
    "and a short reasoning that mentions which named customers they showcase. " +
    "If you cannot find a contact email on their site, OMIT that supplier. Do not invent emails. " +
    "Return JSON array only, no prose.";

  const user =
    `Find 8 small-to-medium manufacturers ${regionHint} that produce in the category: "${category}". ` +
    `They must have their own modern website with named customers shown. Return JSON array.`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL_HEAVY,
      max_tokens: 6000,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });

    let text = response.choices[0]?.message?.content ?? "";
    text = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    const out: Hit[] = [];
    for (const r of parsed) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const name = String(o.company_name || "").trim();
      const website = String(o.website || "").trim();
      const email = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
      if (!name || !website || !email) continue;
      if (!email.includes("@") || !email.includes(".")) continue;
      // Skip obvious junk domains for cold outreach.
      if (/alibaba|made-in-china|globalsources|aliexpress/i.test(website)) continue;
      out.push({
        company_name: name.slice(0, 200),
        website: normalizeUrl(website).slice(0, 300),
        email: email.slice(0, 200),
        contact_name: typeof o.contact_name === "string" ? o.contact_name.slice(0, 120) : undefined,
        country: typeof o.country === "string" ? o.country.slice(0, 80) : undefined,
        reasoning: typeof o.reasoning === "string" ? o.reasoning.slice(0, 500) : undefined,
      });
    }
    return out;
  } catch (err) {
    console.error(`[cold-discovery] ${category}/${region} failed:`, err);
    return [];
  }
}

function normalizeUrl(u: string): string {
  let s = u.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const url = new URL(s);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return s;
  }
}

/**
 * Discover up to N new targets per (category, region) pair, inserting only
 * companies we haven't seen before.
 */
export async function runColdDiscovery(opts: { category?: string; region?: Region } = {}): Promise<number> {
  const cats = opts.category ? [opts.category] : pickRotating(CATEGORIES as readonly string[], 2);
  const regs: Region[] = opts.region ? [opts.region] : pickRotating(REGIONS as readonly Region[], 2) as Region[];

  let inserted = 0;
  for (const c of cats) {
    for (const r of regs) {
      const hits = await discoverOne(c, r);
      for (const h of hits) {
        if (!h.email) continue;
        const { error } = await supabaseAdmin.from("cold_targets").insert({
          company_name: h.company_name,
          website: h.website,
          email: h.email,
          contact_name: h.contact_name || null,
          category: c,
          region: r,
          country: h.country || null,
          discovered_via: "claude-web-search",
          status: "discovered",
          quality_notes: h.reasoning ? { discovery_reasoning: h.reasoning } : {},
        });
        if (!error) inserted++;
      }
    }
  }
  return inserted;
}

function pickRotating<T>(arr: readonly T[], n: number): T[] {
  // Time-based rotation so each cron tick covers different slices.
  const offset = Math.floor(Date.now() / (1000 * 60 * 60)) % arr.length;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[(offset + i) % arr.length]);
  return out;
}

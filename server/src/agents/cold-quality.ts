/**
 * Cold quality agent: visit a discovered supplier's website and score it.
 *
 * Pass criteria (ALL must be true):
 *   - website loads and has modern, professional design
 *   - English content (not Chinese-only)
 *   - shows named customers/brands (e.g. Amazon, Apple, IKEA, Bosch, L'Oréal, Tesla, etc.)
 *
 * Certificates do NOT count toward quality. Named customers do.
 */

import { getOpenAIClient, MODEL_FAST } from "../services/openai.js";
import { supabaseAdmin } from "../services/supabase.js";

type Verdict = {
  qualified: boolean;
  score: number;
  modern_design: boolean;
  english: boolean;
  named_customers: string[];
  notes: string;
};

async function judgeWebsite(website: string): Promise<Verdict | null> {
  const client = getOpenAIClient();

  const system =
    "You evaluate manufacturer websites for B2B buyer outreach. You fetch the homepage and any 'customers', 'clients', 'about', or 'partners' page if linked. " +
    "Return ONLY a JSON object with these fields:\n" +
    "  qualified: boolean — true ONLY if all three are true: modern_design, english, named_customers.length >= 1\n" +
    "  score: integer 0-100\n" +
    "  modern_design: boolean — is the design current/professional (not a 2008-era Alibaba-style page)?\n" +
    "  english: boolean — is the primary content in English (or fluent English version available)?\n" +
    "  named_customers: string[] — actual recognizable brand names shown as customers (e.g. 'Amazon','Bosch','IKEA','Apple','L\\'Oréal','Tesla'). Generic words like 'Fortune 500' do NOT count. Empty array if none shown.\n" +
    "  notes: short string explaining the verdict\n\n" +
    "Certificates (ISO, BSCI, FDA, etc.) do NOT count toward quality. Only named customers do. " +
    "If the site is offline, all-Chinese, or just a templated catalog page with no brand names, qualified=false.";

  try {
    const response = await client.chat.completions.create({
      model: MODEL_FAST,
      max_tokens: 2000,
      messages: [{ role: "system", content: system }, { role: "user", content: `Evaluate this manufacturer's website: ${website}\n\nReturn JSON only.` }],
    });
    let text = response.choices[0]?.message?.content ?? "";
    text = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const v = JSON.parse(text.slice(start, end + 1)) as Partial<Verdict>;
    const namedCustomers = Array.isArray(v.named_customers)
      ? v.named_customers.filter((s) => typeof s === "string" && s.length > 1).map((s) => s.slice(0, 80)).slice(0, 20)
      : [];
    return {
      qualified: !!v.qualified && !!v.modern_design && !!v.english && namedCustomers.length >= 1,
      score: typeof v.score === "number" ? Math.max(0, Math.min(100, v.score)) : 0,
      modern_design: !!v.modern_design,
      english: !!v.english,
      named_customers: namedCustomers,
      notes: typeof v.notes === "string" ? v.notes.slice(0, 600) : "",
    };
  } catch (err) {
    console.error(`[cold-quality] judge failed for ${website}:`, err);
    return null;
  }
}

export async function runColdQuality(limit = 10): Promise<{ qualified: number; disqualified: number }> {
  const { data: targets } = await supabaseAdmin
    .from("cold_targets")
    .select("id, website")
    .eq("status", "discovered")
    .not("website", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  let q = 0;
  let dq = 0;

  for (const t of targets || []) {
    const verdict = await judgeWebsite(t.website as string);
    if (!verdict) {
      await supabaseAdmin.from("cold_targets")
        .update({ status: "disqualified", quality_notes: { error: "judge_failed" }, last_event_at: new Date().toISOString() })
        .eq("id", t.id);
      dq++;
      continue;
    }
    if (verdict.qualified) {
      await supabaseAdmin.from("cold_targets")
        .update({
          status: "qualified",
          quality_score: verdict.score,
          quality_notes: { notes: verdict.notes, modern_design: verdict.modern_design, english: verdict.english },
          named_customers: verdict.named_customers,
          qualified_at: new Date().toISOString(),
          last_event_at: new Date().toISOString(),
        })
        .eq("id", t.id);
      q++;
    } else {
      await supabaseAdmin.from("cold_targets")
        .update({
          status: "disqualified",
          quality_score: verdict.score,
          quality_notes: { notes: verdict.notes, modern_design: verdict.modern_design, english: verdict.english },
          named_customers: verdict.named_customers,
          last_event_at: new Date().toISOString(),
        })
        .eq("id", t.id);
      dq++;
    }
  }
  return { qualified: q, disqualified: dq };
}

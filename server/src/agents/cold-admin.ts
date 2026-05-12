/**
 * Admin one-shot cold outreach.
 *
 * Takes a natural-language instruction ("search 20 high quality manufacturers
 * from hong kong right now and email them for a meeting this week at their
 * factory") and:
 *   1. Parses it via Claude into structured params (count, region, country,
 *      category, custom angle/CTA).
 *   2. Runs discovery + quality + draft + send pipeline with those params.
 *   3. Returns a log of what was sent.
 */

import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";
import { sendEmail } from "../services/email.js";

const MODEL = "claude-sonnet-4-6";

type Parsed = {
  count: number;
  region: "CN" | "US" | "EU" | "OTHER";
  country: string | null;
  category: string;
  angle: string;
  cta: string;
};

type Lead = {
  company_name: string;
  website: string;
  email: string;
  contact_name?: string;
  country?: string;
  named_customers?: string[];
  reasoning?: string;
};

async function parseInstruction(instruction: string): Promise<Parsed | null> {
  const anthropic = getAnthropicClient();
  const system =
    "Parse an admin instruction for a cold outreach run. Return JSON only with fields: " +
    "count (integer, 1-30), region ('CN','US','EU','OTHER'), country (string or null, like 'Hong Kong'), " +
    "category (short string, e.g. 'electronics-manufacturing', 'cosmetics-packaging', 'medical-devices'), " +
    "angle (one sentence describing the email's specific hook or purpose, in the admin's voice), " +
    "cta (one sentence describing the requested action, e.g. 'invite them to a factory visit this week'). " +
    "Default count is 10 if unspecified. If a city is named (Hong Kong, Shenzhen, Berlin), set country to that. " +
    "Return ONLY JSON, no prose.";
  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: instruction }],
    });
    let txt = "";
    for (const b of r.content) if (b.type === "text") txt += b.text;
    txt = txt.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const s = txt.indexOf("{");
    const e = txt.lastIndexOf("}");
    if (s === -1 || e === -1) return null;
    const v = JSON.parse(txt.slice(s, e + 1)) as Partial<Parsed>;
    return {
      count: Math.max(1, Math.min(30, Number(v.count) || 10)),
      region: (["CN", "US", "EU", "OTHER"] as const).includes(v.region as "CN") ? (v.region as Parsed["region"]) : "OTHER",
      country: typeof v.country === "string" ? v.country.slice(0, 80) : null,
      category: typeof v.category === "string" ? v.category.slice(0, 80) : "manufacturing",
      angle: typeof v.angle === "string" ? v.angle.slice(0, 400) : instruction.slice(0, 400),
      cta: typeof v.cta === "string" ? v.cta.slice(0, 200) : "Take a look at https://airsup.dev/start",
    };
  } catch (err) {
    console.error("[cold-admin] parse failed:", err);
    return null;
  }
}

async function discoverLeads(p: Parsed, skipEmails: string[]): Promise<Lead[]> {
  const anthropic = getAnthropicClient();
  const where = p.country ? `in ${p.country}` : `in region ${p.region}`;

  const skipLine = skipEmails.length > 0
    ? `\nDo NOT include any company whose email is in this list (already contacted): ${skipEmails.join(", ")}.`
    : "";

  const system =
    "You research real manufacturers and return high quality leads only. " +
    "Return JSON array. Each lead: company_name, website (root URL), email (real visible contact email, must be on their own domain), " +
    "country, contact_name if shown, named_customers (array of brand names they show on their site), reasoning (one short sentence why they qualify). " +
    "STRICT quality bar: the supplier's own website must be in English, modern, professional, and show at least one named brand customer. " +
    "Skip Alibaba, Made-in-China, Global Sources storefronts and trading-company resellers. " +
    "If you cannot find a real contact email, OMIT that supplier. Do not invent emails or URLs." +
    skipLine;

  const user =
    `Find ${p.count} high quality manufacturers ${where} in the category: ${p.category}. ` +
    `Context for the outreach: ${p.angle}. ` +
    `Return JSON array only.`;

  const webSearchTool = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 25,
  } as unknown;

  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system,
      tools: [webSearchTool] as Parameters<typeof anthropic.messages.create>[0]["tools"],
      messages: [{ role: "user", content: user }],
    });
    let txt = "";
    for (const b of r.content) if (b.type === "text") txt += b.text;
    txt = txt.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const s = txt.indexOf("[");
    const e = txt.lastIndexOf("]");
    if (s === -1 || e === -1) return [];
    const arr = JSON.parse(txt.slice(s, e + 1));
    if (!Array.isArray(arr)) return [];
    const out: Lead[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const name = String(o.company_name || "").trim();
      const site = String(o.website || "").trim();
      const email = typeof o.email === "string" ? o.email.trim().toLowerCase() : "";
      if (!name || !site || !email.includes("@")) continue;
      if (/alibaba|made-in-china|globalsources|aliexpress/i.test(site)) continue;
      out.push({
        company_name: name.slice(0, 200),
        website: normalizeUrl(site).slice(0, 300),
        email: email.slice(0, 200),
        contact_name: typeof o.contact_name === "string" ? o.contact_name.slice(0, 120) : undefined,
        country: typeof o.country === "string" ? o.country.slice(0, 80) : undefined,
        named_customers: Array.isArray(o.named_customers) ? (o.named_customers as unknown[]).filter((x) => typeof x === "string").map((x) => String(x).slice(0, 80)).slice(0, 10) : [],
        reasoning: typeof o.reasoning === "string" ? o.reasoning.slice(0, 400) : undefined,
      });
      if (out.length >= p.count) break;
    }
    return out;
  } catch (err) {
    console.error("[cold-admin] discover failed:", err);
    return [];
  }
}

function normalizeUrl(u: string): string {
  let s = u.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { const url = new URL(s); return `${url.protocol}//${url.hostname}`; } catch { return s; }
}

async function draftCustomEmail(lead: Lead, p: Parsed): Promise<{ subject: string; body: string } | null> {
  const anthropic = getAnthropicClient();

  const system =
    "You write very short, friendly cold outreach emails from Konstantin, founder of Airsup (airsup.dev). " +
    "Airsup is a platform that matches manufacturers with Western founders and buyers. It is free for suppliers.\n\n" +
    "TONE: nice and cool, like a casual hello from a real person. Never salesy. Never hypey. " +
    "Do NOT brag. Do NOT name their customers back to them. Do NOT use phrases like 'speaks for itself', 'no commission', 'free to join', 'qualified leads'.\n\n" +
    "STYLE RULES (strict):\n" +
    "  - Plain text only. No markdown, no bullets, no asterisks.\n" +
    "  - 40 to 80 words MAX.\n" +
    "  - No em-dashes or en-dashes (— or –).\n" +
    "  - No forward slashes for word separation. URLs are fine.\n" +
    "  - First sentence is a low-key opener that shows you looked at their site.\n" +
    "  - Honour the admin's specific angle and CTA in the body.\n" +
    "  - Sign 'Konstantin' on its own line. No footer, no signature block, no address.\n" +
    "  - Subject under 50 chars, lowercase, friendly, no em-dashes, no slashes, no clickbait, no exclamation marks.\n" +
    "Return JSON: { \"subject\": string, \"body\": string }.";

  const user =
    `Company: ${lead.company_name}\n` +
    `Category: ${p.category}\n` +
    `Country: ${lead.country || p.country || "unknown"}\n` +
    `Website: ${lead.website}\n` +
    `Contact name: ${lead.contact_name || "unknown"}\n\n` +
    `Admin's angle for this outreach: ${p.angle}\n` +
    `Specific call to action to include: ${p.cta}\n\n` +
    `Write the email. JSON only.`;

  const tryDraft = async (sys: string, usr: string) => {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: sys,
      messages: [{ role: "user", content: usr }],
    });
    let txt = "";
    for (const b of r.content) if (b.type === "text") txt += b.text;
    console.log(`[cold-admin] draft raw for ${lead.email}:`, txt.slice(0, 300));
    txt = txt.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const s = txt.indexOf("{");
    const e = txt.lastIndexOf("}");
    if (s === -1 || e === -1) throw new Error("no JSON object in response");
    const v = JSON.parse(txt.slice(s, e + 1)) as { subject?: string; body?: string };
    if (!v.subject || !v.body) throw new Error("missing subject or body");
    return { subject: v.subject.slice(0, 80), body: v.body };
  };

  try {
    return await tryDraft(system, user);
  } catch (err) {
    console.error(`[cold-admin] draft attempt 1 failed for ${lead.email}:`, err);
    // Retry with a simpler prompt
    try {
      const fallbackUser = `Write a short cold email (40-70 words, plain text) from Konstantin at Airsup (airsup.dev) to ${lead.company_name} (${lead.website}). ${p.angle}. Sign just "Konstantin". Return JSON: { "subject": string, "body": string }`;
      return await tryDraft('Return JSON only: { "subject": string, "body": string }. Plain text email body, 40-70 words, no markdown.', fallbackUser);
    } catch (err2) {
      console.error(`[cold-admin] draft attempt 2 failed for ${lead.email}:`, err2);
      return null;
    }
  }
}

export type AdminTaskResult = {
  ok: boolean;
  parsed: Parsed | null;
  discovered: number;
  sent: Array<{ company: string; email: string; subject: string }>;
  skipped: Array<{ company: string; email: string; reason: string }>;
  error?: string;
};

export async function runColdAdminTask(instruction: string): Promise<AdminTaskResult> {
  const parsed = await parseInstruction(instruction);
  if (!parsed) return { ok: false, parsed: null, discovered: 0, sent: [], skipped: [], error: "Could not parse instruction." };

  // Fetch all known emails so discovery avoids them
  const { data: knownRows } = await supabaseAdmin
    .from("cold_targets")
    .select("email")
    .not("status", "eq", "discovered");
  const skipEmails = (knownRows || []).map((r: { email: string }) => r.email).filter(Boolean);

  const leads = await discoverLeads(parsed, skipEmails);
  const sent: AdminTaskResult["sent"] = [];
  const skipped: AdminTaskResult["skipped"] = [];

  for (const lead of leads) {
    const { data: existing } = await supabaseAdmin
      .from("cold_targets")
      .select("id, status")
      .eq("email", lead.email)
      .maybeSingle();

    if (existing && (existing as { status: string }).status !== "discovered") {
      skipped.push({ company: lead.company_name, email: lead.email, reason: "already contacted" });
      continue;
    }

    let targetId: string;
    if (existing?.id) {
      targetId = (existing as { id: string }).id;
    } else {
      const { data: inserted, error: iErr } = await supabaseAdmin
        .from("cold_targets")
        .insert({
          company_name: lead.company_name,
          website: lead.website,
          email: lead.email,
          contact_name: lead.contact_name || null,
          category: parsed.category,
          region: parsed.region,
          country: lead.country || parsed.country || null,
          discovered_via: "admin-task",
          named_customers: lead.named_customers || [],
          quality_notes: { admin_angle: parsed.angle, reasoning: lead.reasoning || "" },
          status: "qualified",
          qualified_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (iErr || !inserted) {
        skipped.push({ company: lead.company_name, email: lead.email, reason: "db insert failed" });
        continue;
      }
      targetId = (inserted as { id: string }).id;
    }

    const draft = await draftCustomEmail(lead, parsed);
    if (!draft) {
      skipped.push({ company: lead.company_name, email: lead.email, reason: "draft failed" });
      continue;
    }

    try {
      const result = await sendEmail({
        to: lead.email,
        subject: draft.subject,
        text: draft.body,
        bcc: process.env.COLD_BCC_EMAIL || "pytrobusiness@gmail.com",
      });
      await supabaseAdmin.from("cold_emails").insert({
        target_id: targetId,
        direction: "outbound",
        subject: draft.subject,
        body: draft.body,
        message_id: result.messageId,
        from_email: process.env.IONOS_SMTP_USER || "konstantin@airsup.dev",
        to_email: lead.email,
      });
      await supabaseAdmin.from("cold_targets")
        .update({ status: "contacted", contacted_at: new Date().toISOString(), last_event_at: new Date().toISOString() })
        .eq("id", targetId);
      sent.push({ company: lead.company_name, email: lead.email, subject: draft.subject });
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
    } catch (err) {
      skipped.push({ company: lead.company_name, email: lead.email, reason: (err as Error).message });
    }
  }

  return { ok: true, parsed, discovered: leads.length, sent, skipped };
}

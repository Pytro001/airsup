/**
 * Cold outreach agent: send a unique first email to a qualified target.
 *
 * Goal: get them to finish onboarding at https://airsup.dev/start
 * Persona: Konstantin from Airsup. Short, specific, references their actual
 * named customers / category, no spammy templates.
 *
 * Rate limited by COLD_DAILY_LIMIT (default 40) per UTC day.
 */

import { getOpenAIClient, MODEL_FAST } from "../services/openai.js";
import { supabaseAdmin } from "../services/supabase.js";
import { sendEmail } from "../services/email.js";

const ONBOARD_URL = "https://airsup.dev/start";
const DAILY_LIMIT = parseInt(process.env.COLD_DAILY_LIMIT || "40", 10);

type Target = {
  id: string;
  company_name: string;
  email: string;
  contact_name: string | null;
  category: string;
  region: string;
  country: string | null;
  named_customers: string[] | null;
  website: string | null;
  unsub_token: string | null;
};

async function draftEmail(t: Target): Promise<{ subject: string; body: string } | null> {
  const client = getOpenAIClient();

  const system =
    "You write very short, friendly cold outreach emails from Konstantin, the founder of Airsup (airsup.dev). " +
    "Airsup is a platform that matches manufacturers with Western founders and buyers. It is free for suppliers.\n\n" +
    "TONE: nice and cool, like a casual hello from a real person. Never salesy. Never hypey. " +
    "Do NOT brag about the company or list selling points. Do NOT name their customers back to them. Do NOT use phrases like 'speaks for itself', 'no commission', 'free to join', 'qualified leads', 'best in class'.\n\n" +
    "STYLE RULES (strict):\n" +
    "  - Plain text only. No markdown, no bullets, no asterisks.\n" +
    "  - 40 to 70 words MAX. Short.\n" +
    "  - No em-dashes or en-dashes (— or –).\n" +
    "  - No forward slashes for word separation. URLs are fine.\n" +
    "  - First sentence is a friendly, low-key opener that just shows you actually looked at their site (their category or country is plenty).\n" +
    "  - One short sentence about what Airsup is, in plain words. Mention it is free for suppliers exactly once, casually.\n" +
    "  - One soft CTA with the link https://airsup.dev/start.\n" +
    "  - Sign 'Konstantin' on its own line. No footer, no signature block, no address.\n" +
    "  - Subject under 50 chars, lowercase, friendly, no em-dashes, no slashes, no clickbait, no exclamation marks.\n" +
    "Return JSON: { \"subject\": string, \"body\": string }.";

  const user =
    `Company: ${t.company_name}\n` +
    `Category: ${t.category}\n` +
    `Region: ${t.region}${t.country ? " (" + t.country + ")" : ""}\n` +
    `Website: ${t.website || "unknown"}\n` +
    `Contact name: ${t.contact_name || "unknown"}\n` +
    `\nWrite the email. JSON only.`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL_FAST,
      max_tokens: 1000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    let text = response.choices[0]?.message?.content ?? "";
    text = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as { subject?: string; body?: string };
    if (!parsed.subject || !parsed.body) return null;
    // Ensure the onboarding link is present.
    let body = parsed.body;
    if (!body.includes(ONBOARD_URL)) body += `\n\n${ONBOARD_URL}`;
    return { subject: parsed.subject.slice(0, 80), body };
  } catch (err) {
    console.error(`[cold-outreach] draft failed for ${t.id}:`, err);
    return null;
  }
}

async function sentTodayCount(): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from("cold_emails")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .gte("sent_at", since.toISOString());
  return count || 0;
}

export async function runColdOutreach(limit = 10): Promise<number> {
  const remainingToday = DAILY_LIMIT - (await sentTodayCount());
  if (remainingToday <= 0) return 0;
  const take = Math.min(limit, remainingToday);

  const { data: targets } = await supabaseAdmin
    .from("cold_targets")
    .select("id, company_name, email, contact_name, category, region, country, named_customers, website, unsub_token")
    .eq("status", "qualified")
    .order("qualified_at", { ascending: true })
    .limit(take);

  let sent = 0;
  for (const raw of targets || []) {
    const t = raw as Target;
    if (!t.email) continue;

    const draft = await draftEmail(t);
    if (!draft) continue;

    try {
      const result = await sendEmail({
        to: t.email,
        subject: draft.subject,
        text: draft.body,
        unsubscribeToken: t.unsub_token || undefined,
        bcc: process.env.COLD_BCC_EMAIL || "konstantin@airsup.dev",
      });

      await supabaseAdmin.from("cold_emails").insert({
        target_id: t.id,
        direction: "outbound",
        subject: draft.subject,
        body: draft.body,
        message_id: result.messageId,
        from_email: process.env.IONOS_SMTP_USER || "konstantin@airsup.dev",
        to_email: t.email,
      });

      await supabaseAdmin.from("cold_targets")
        .update({ status: "contacted", contacted_at: new Date().toISOString(), last_event_at: new Date().toISOString() })
        .eq("id", t.id);

      sent++;

      // Small jitter between sends so it doesn't look like a burst.
      await sleep(2000 + Math.random() * 4000);
    } catch (err) {
      console.error(`[cold-outreach] send failed for ${t.email}:`, err);
    }
  }
  return sent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

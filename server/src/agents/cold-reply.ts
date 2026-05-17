/**
 * Cold reply agent: poll IONOS IMAP, match inbound emails to a cold_target,
 * draft a contextual reply that pushes them toward onboarding at /start, and
 * stop when they sign up, opt out, or go cold.
 */

import { getOpenAIClient, MODEL_FAST } from "../services/openai.js";
import { supabaseAdmin } from "../services/supabase.js";
import { fetchUnreadEmails, sendEmail, type InboundEmail } from "../services/email.js";

const ONBOARD_URL = "https://airsup.dev/start";

type ThreadMsg = { direction: "outbound" | "inbound"; subject: string | null; body: string };

const STOP_WORDS = /\b(unsubscribe|stop|remove me|opt[\s-]?out|do not contact|leave me alone|退订)\b/i;

async function findTargetByEmail(from: string): Promise<string | null> {
  const email = from.toLowerCase().trim();
  if (!email) return null;
  const { data } = await supabaseAdmin
    .from("cold_targets")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  return (data?.id as string) || null;
}

async function loadThread(targetId: string): Promise<ThreadMsg[]> {
  const { data } = await supabaseAdmin
    .from("cold_emails")
    .select("direction, subject, body")
    .eq("target_id", targetId)
    .order("sent_at", { ascending: true });
  return (data || []) as ThreadMsg[];
}

async function draftReply(targetId: string, lastInboundSubject: string): Promise<{ subject: string; body: string } | null> {
  const client = getOpenAIClient();
  const thread = await loadThread(targetId);
  const { data: tgtRaw } = await supabaseAdmin
    .from("cold_targets")
    .select("company_name, category, region, country, named_customers")
    .eq("id", targetId)
    .single();
  const tgt = tgtRaw as { company_name: string; category: string; region: string; country: string | null; named_customers: string[] | null };

  const system =
    "You are Konstantin replying to a manufacturer who answered your cold outreach for Airsup (airsup.dev). " +
    "Goal: get them to finish onboarding at https://airsup.dev/start.\n\n" +
    "STYLE RULES (strict):\n" +
    "  - Plain text. No markdown, no bullets, no asterisks.\n" +
    "  - 40 to 100 words MAX. Short and warm, never pushy.\n" +
    "  - Do NOT use em-dashes or en-dashes (— or –). Use a period or comma.\n" +
    "  - Do NOT use forward slashes for word separation. Write 'and' or a comma. URLs are fine.\n" +
    "  - Answer their actual question directly.\n" +
    "  - If they ask cost: 'free for suppliers, Airsup makes money on the buyer side.'\n" +
    "  - If they ask how it works: curated Western founders and buyers, AI matches them to vetted factories, you accept or decline inquiries, you talk directly, Airsup never takes commission.\n" +
    "  - If they ask for a call: agree, ask for preferred time and timezone.\n" +
    "  - Include https://airsup.dev/start once if relevant.\n" +
    "  - Sign 'Konstantin' on its own line. No footer, no address block.\n" +
    "Return JSON: { \"subject\": string, \"body\": string }.";

  const threadText = thread.map((m, i) => `[${i + 1}] ${m.direction === "outbound" ? "Konstantin" : "Them"}: ${m.body.slice(0, 1500)}`).join("\n\n");

  const user =
    `Target: ${tgt.company_name} (${tgt.category}, ${tgt.region}${tgt.country ? ", " + tgt.country : ""})\n` +
    `Named customers: ${(tgt.named_customers || []).join(", ") || "n/a"}\n\n` +
    `Thread so far:\n${threadText}\n\n` +
    `Draft my next reply. JSON only.`;

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
    if (!parsed.body) return null;
    const subject = parsed.subject || (lastInboundSubject.startsWith("Re:") ? lastInboundSubject : `Re: ${lastInboundSubject}`);
    return { subject: subject.slice(0, 80), body: parsed.body };
  } catch (err) {
    console.error(`[cold-reply] draft failed for ${targetId}:`, err);
    return null;
  }
}

async function handleInbound(msg: InboundEmail): Promise<void> {
  const targetId = await findTargetByEmail(msg.from);
  if (!targetId) return; // unknown sender — ignore

  // Record inbound first.
  await supabaseAdmin.from("cold_emails").insert({
    target_id: targetId,
    direction: "inbound",
    subject: msg.subject,
    body: msg.text,
    message_id: msg.messageId || null,
    in_reply_to: msg.inReplyTo || null,
    from_email: msg.from,
    to_email: msg.to,
    sent_at: msg.date.toISOString(),
    processed: false,
  });

  // Opt-out handling.
  if (STOP_WORDS.test(msg.text) || STOP_WORDS.test(msg.subject || "")) {
    await supabaseAdmin.from("cold_targets")
      .update({ status: "unsubscribed", last_event_at: new Date().toISOString() })
      .eq("id", targetId);
    return;
  }

  // Mark target as in-thread.
  await supabaseAdmin.from("cold_targets")
    .update({ status: "replying", last_event_at: new Date().toISOString() })
    .eq("id", targetId);

  const draft = await draftReply(targetId, msg.subject || "Airsup");
  if (!draft) return;

  // Pull unsub token + references.
  const { data: tgt } = await supabaseAdmin
    .from("cold_targets")
    .select("email, unsub_token")
    .eq("id", targetId)
    .single();
  if (!tgt?.email) return;

  try {
    const result = await sendEmail({
      to: tgt.email as string,
      subject: draft.subject,
      text: draft.body,
      inReplyTo: msg.messageId || undefined,
      references: msg.messageId ? [...(msg.references || []), msg.messageId] : msg.references,
      unsubscribeToken: (tgt.unsub_token as string) || undefined,
    });

    await supabaseAdmin.from("cold_emails").insert({
      target_id: targetId,
      direction: "outbound",
      subject: draft.subject,
      body: draft.body,
      message_id: result.messageId,
      in_reply_to: msg.messageId || null,
      from_email: process.env.IONOS_SMTP_USER || "konstantin@airsup.dev",
      to_email: tgt.email as string,
    });
  } catch (err) {
    console.error(`[cold-reply] send failed for ${targetId}:`, err);
  }
}

export async function runColdReply(): Promise<number> {
  let unread: InboundEmail[] = [];
  try {
    unread = await fetchUnreadEmails(50);
  } catch (err) {
    console.error("[cold-reply] IMAP fetch failed:", err);
    return 0;
  }

  let processed = 0;
  for (const msg of unread) {
    try {
      await handleInbound(msg);
      processed++;
    } catch (err) {
      console.error("[cold-reply] handle failed:", err);
    }
  }
  return processed;
}

/**
 * Mark targets as converted if a profile/factory with their email finished onboarding.
 */
export async function reconcileConversions(): Promise<number> {
  const { data: contacted } = await supabaseAdmin
    .from("cold_targets")
    .select("id, email")
    .in("status", ["contacted", "replying"]);
  if (!contacted || !contacted.length) return 0;

  const emails = contacted.map((t) => (t as { email: string }).email).filter(Boolean);
  if (!emails.length) return 0;

  const { data: profiles } = await supabaseAdmin
    .from("profiles")
    .select("email")
    .in("email", emails);

  const onboardedSet = new Set((profiles || []).map((p) => (p as { email: string }).email.toLowerCase()));
  let n = 0;
  for (const t of contacted as { id: string; email: string }[]) {
    if (onboardedSet.has(t.email.toLowerCase())) {
      await supabaseAdmin.from("cold_targets")
        .update({ status: "converted", last_event_at: new Date().toISOString() })
        .eq("id", t.id);
      n++;
    }
  }
  return n;
}

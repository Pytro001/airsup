import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";
import { DISALLOWED_MATCH_STATUSES } from "./visit-planner.js";

export type VisitProposalDraft = {
  match_id: string;
  factory_id: number;
  factory_name: string;
  scheduled_time: string;
  en: string;
  zh: string;
};

/**
 * Bilingual (EN + ZH) draft messages to send in connection chat — buyer reviews before sending.
 */
export async function draftProposalsForVisitPlan(
  userId: string,
  planId: string
): Promise<{ drafts: VisitProposalDraft[] } | { error: string; code: string }> {
  const { data: plan, error } = await supabaseAdmin
    .from("visit_plans")
    .select(
      `id, travel_date, region, user_id, visit_stops(
        id, factory_id, scheduled_time, match_id, notes,
        factories(name, location)
      )`
    )
    .eq("id", planId)
    .eq("user_id", userId)
    .single();

  if (error || !plan) {
    return { error: "Visit plan not found.", code: "NOT_FOUND" };
  }

  const stops = (plan.visit_stops || []) as Array<{
    factory_id: number;
    scheduled_time: string | null;
    match_id: string | null;
    notes: string | null;
    factories: { name: string; location: string } | { name: string; location: string }[] | null;
  }>;
  if (!stops.length) {
    return { error: "No stops on this plan.", code: "EMPTY" };
  }

  const withMatch = stops.filter((s) => s.match_id);
  if (!withMatch.length) {
    return { error: "Stops are missing match context. Re-create the plan with match-based planning.", code: "NO_MATCH" };
  }

  const matchIds = [...new Set(withMatch.map((s) => s.match_id!))];
  const { data: matches, error: mErr } = await supabaseAdmin
    .from("matches")
    .select("id, context_summary, projects!inner(title)")
    .in("id", matchIds);

  if (mErr || !matches) {
    return { error: mErr?.message || "Could not load matches", code: "DB_ERROR" };
  }

  const matchMap = new Map(
    (matches as Array<{
      id: string;
      context_summary: unknown;
      projects: { title: string } | { title: string }[];
    }>).map((m) => {
      const p = Array.isArray(m.projects) ? m.projects[0] : m.projects;
      return [m.id, { context: (m.context_summary as Record<string, unknown>) || {}, projectTitle: p?.title || "" }];
    })
  );

  const payload = withMatch.map((s) => {
    const f = s.factories
      ? Array.isArray(s.factories)
        ? s.factories[0]
        : s.factories
      : { name: "", location: "" };
    const m = s.match_id ? matchMap.get(s.match_id) : undefined;
    return {
      match_id: s.match_id!,
      factory_id: s.factory_id,
      factory_name: f?.name || "Factory",
      location: f?.location || "",
      project_title: m?.projectTitle || "",
      context_summary: m?.context || {},
      scheduled_time: s.scheduled_time || "",
      planner_note: s.notes || "",
    };
  });

  const anthropic = getAnthropicClient();
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system:
      "You help buyers message factories on Airsup. Return ONLY a JSON array of objects: " +
      "[{ \"match_id\": string (UUID), \"en\": string, \"zh\": string }]. " +
      "Each message proposes visiting on the plan date at the given time, references the project, and stays under 4 sentences in each language. " +
      "Professional, concise, one factory supplier tone.",
    messages: [
      {
        role: "user",
        content: `Visit plan date: ${plan.travel_date}. Region: ${plan.region}.\nStops to write:\n${JSON.stringify(
          payload,
          null,
          2
        )}`,
      },
    ],
  });

  const text = res.content[0]?.type === "text" ? res.content[0].text : "[]";
  let arr: Array<{ match_id: string; en: string; zh: string }> = [];
  try {
    arr = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim());
  } catch {
    return { error: "Could not parse draft messages from model.", code: "PARSE" };
  }
  if (!Array.isArray(arr)) {
    return { error: "Model returned invalid format.", code: "PARSE" };
  }

  const byMatch = new Map<string, { en: string; zh: string }>();
  for (const row of arr) {
    if (typeof row?.match_id === "string" && typeof row?.en === "string" && typeof row?.zh === "string") {
      byMatch.set(row.match_id, { en: row.en.trim(), zh: row.zh.trim() });
    }
  }

  const drafts: VisitProposalDraft[] = withMatch.map((s) => {
    const f = s.factories
      ? Array.isArray(s.factories)
        ? s.factories[0]
        : s.factories
      : { name: "", location: "" };
    const d = s.match_id ? byMatch.get(s.match_id) : undefined;
    return {
      match_id: s.match_id!,
      factory_id: s.factory_id,
      factory_name: f?.name || "Factory",
      scheduled_time: s.scheduled_time || "",
      en: d?.en || `We would like to visit on ${plan.travel_date} at ${s.scheduled_time || "TBD"}.`,
      zh: d?.zh || `我们希望在${plan.travel_date}${s.scheduled_time ? " " + s.scheduled_time : ""}进行拜访。`,
    };
  });

  return { drafts };
}

type SubmitVisitErr = { error: string; code: string };

/**
 * Transitions all draft stops on a plan to pending_supplier, drafts bilingual
 * [Visit proposal] connection chat messages, and posts them as the buyer.
 */
export async function sendVisitProposalsToSuppliers(
  userId: string,
  planId: string
): Promise<{ sent: number } | SubmitVisitErr> {
  const { data: plan, error: pErr } = await supabaseAdmin
    .from("visit_plans")
    .select(
      `id, travel_date, region, user_id, route,
       visit_stops(
         id, factory_id, scheduled_time, match_id, notes, confirmation_status,
         factories(name, location)
       )`
    )
    .eq("id", planId)
    .eq("user_id", userId)
    .single();

  if (pErr || !plan) {
    return { error: "Visit plan not found.", code: "NOT_FOUND" };
  }

  const stops = (plan.visit_stops || []) as Array<{
    id: string;
    factory_id: number;
    scheduled_time: string | null;
    match_id: string | null;
    notes: string | null;
    confirmation_status: string;
    factories: { name: string; location: string } | { name: string; location: string }[] | null;
  }>;
  const draftStops = stops.filter((s) => s.confirmation_status === "draft");
  if (!draftStops.length) {
    return { error: "No visit stops in draft to send. Add visits or wait for a new plan.", code: "NO_DRAFT" };
  }
  for (const s of draftStops) {
    if (!s.match_id) {
      return { error: "A stop is missing a match. Rebuild this plan with match-based planning.", code: "NO_MATCH" };
    }
  }

  const matchIds = [...new Set(draftStops.map((s) => s.match_id!))];
  const { data: matches, error: mErr } = await supabaseAdmin
    .from("matches")
    .select("id, status, context_summary, projects!inner(title)")
    .in("id", matchIds);

  if (mErr || !matches?.length) {
    return { error: mErr?.message || "Could not load matches", code: "DB_ERROR" };
  }

  const byMatch = new Map(
    (matches as Array<{
      id: string;
      status: string;
      context_summary: unknown;
      projects: { title: string } | { title: string }[];
    }>).map((m) => {
      const p = Array.isArray(m.projects) ? m.projects[0] : m.projects;
      return [m.id, { status: m.status, projectTitle: p?.title || "" }];
    })
  );
  for (const mid of matchIds) {
    const m = byMatch.get(mid);
    if (!m || DISALLOWED_MATCH_STATUSES.has(m.status)) {
      return { error: "One or more connections are not active for visit confirmation.", code: "INVALID_MATCH" };
    }
  }

  const { data: co } = await supabaseAdmin
    .from("companies")
    .select("name")
    .eq("user_id", userId)
    .maybeSingle();
  const buyerCo = (co?.name as string | undefined)?.trim() || "Buyer";

  const byMatchStops = new Map<string, typeof draftStops>();
  for (const s of draftStops) {
    const k = s.match_id!;
    if (!byMatchStops.has(k)) byMatchStops.set(k, []);
    byMatchStops.get(k)!.push(s);
  }

  const payload = [...byMatchStops.entries()].map(([match_id, st]) => {
    const m = byMatch.get(match_id);
    const first = st[0];
    const f = first.factories
      ? Array.isArray(first.factories)
        ? first.factories[0]
        : first.factories
      : { name: "", location: "" };
    return {
      match_id,
      project_title: m?.projectTitle || "",
      factory_name: f?.name || "Factory",
      stops: st.map((x) => ({
        scheduled_time: x.scheduled_time || "",
        note: (x.notes || "").slice(0, 200),
      })),
    };
  });

  const anthropic = getAnthropicClient();
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system:
      "You help buyers message factory suppliers on Airsup. Return ONLY a JSON array: " +
      "[{ \"match_id\": string (UUID), \"en\": string, \"zh\": string }]. " +
      "For each item, write a short message asking the factory to **confirm the proposed visit time(s) or suggest a better time** via the platform. " +
      "Mention the buyer company, project, date " +
      plan.travel_date +
      ", and each proposed time. Professional, 3–4 sentences per language. " +
      "Do not add markdown.",
    messages: [
      {
        role: "user",
        content: `Buyer company: ${buyerCo}.\nRegion: ${plan.region}.\nItems:\n${JSON.stringify(
          payload,
          null,
          2
        )}`,
      },
    ],
  });

  const text = res.content[0]?.type === "text" ? res.content[0].text : "[]";
  let arr: Array<{ match_id: string; en: string; zh: string }> = [];
  try {
    arr = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim());
  } catch {
    return { error: "Could not parse proposal messages from model.", code: "PARSE" };
  }
  if (!Array.isArray(arr)) {
    return { error: "Model returned invalid format.", code: "PARSE" };
  }
  const textBy = new Map<string, { en: string; zh: string }>();
  for (const row of arr) {
    if (typeof row?.match_id === "string" && typeof row?.en === "string" && typeof row?.zh === "string") {
      textBy.set(row.match_id, { en: row.en.trim(), zh: row.zh.trim() });
    }
  }

  for (const mid of matchIds) {
    const d = textBy.get(mid) || { en: "", zh: "" };
    if (!d.en || !d.zh) {
      return { error: "Model did not return messages for every match.", code: "PARSE" };
    }
  }

  const stopIds = draftStops.map((s) => s.id);
  const { error: uerr } = await supabaseAdmin
    .from("visit_stops")
    .update({ confirmation_status: "pending_supplier" })
    .in("id", stopIds)
    .eq("plan_id", planId);
  if (uerr) {
    return { error: uerr.message, code: "DB_ERROR" };
  }

  let sent = 0;
  for (const mid of matchIds) {
    const d = textBy.get(mid)!;
    const full = `[Visit proposal]\n\n${d.en}\n\n${d.zh}`;
    const { error: ins } = await supabaseAdmin
      .from("connection_messages")
      .insert({ match_id: mid, sender_id: userId, content: full });
    if (ins) {
      return { error: ins.message, code: "DB_ERROR" };
    }
    sent += 1;
  }

  return { sent };
}

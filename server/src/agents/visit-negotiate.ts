import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

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

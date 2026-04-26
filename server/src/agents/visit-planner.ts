import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";
import {
  amapGeocodeAddress,
  amapDrivingLeg,
  isGcjInChinaBbox,
  isLikelyChinaFromText,
  hasAmapConfigured,
  orderStopsByDrivingHeuristic,
} from "../lib/amap.js";

export const DISALLOWED_MATCH_STATUSES = new Set(["cancelled", "disputed"]);

export type ResolvedFactoryRow = {
  matchId: string;
  factoryId: number;
  projectId: string;
  projectTitle: string;
  contextSummary: Record<string, unknown>;
};

interface FactoryLocation {
  idx: number;
  factoryId: number;
  matchId: string;
  name: string;
  location: string;
  projectTitle: string;
  /** Chinese-friendly line for the UI; may equal address or Amap POI. */
  locationZh?: string;
  lat?: number;
  lng?: number;
  geocoded: boolean;
  useAmapRouting: boolean;
}

export type PlanVisitsInput = { startDate: string; matchIds?: string[]; factoryIds?: number[] };

export type PlanResult = {
  plans: Array<{
    date: string;
    region: string;
    route: {
      match_ids: string[];
      project_titles: string[];
      factory_ids: number[];
      amap: boolean;
      warnings?: string[];
      stop_details?: Array<{
        factory_id: number;
        match_id: string;
        location_zh: string;
        amap_url?: string;
        project_title: string;
        /** GCJ-02 when from Amap / geocode; use for 高德 static map. */
        lat: number | null;
        lng: number | null;
      }>;
    };
    stops: Array<{
      factoryId: number;
      matchId: string;
      name: string;
      time: string;
      locationZh: string;
      amapUrl?: string;
      projectTitle: string;
      notes?: string;
      lat?: number;
      lng?: number;
    }>;
  }>;
  warnings: string[];
};

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeNominatim(
  location: string,
  lang: "en" | "zh"
): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
      { headers: { "User-Agent": "Airsup/1.0", "Accept-Language": lang } }
    );
    const data = await res.json();
    if (data?.[0]) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (err) {
    console.warn("[VisitPlanner] Nominatim geocode failed:", err);
  }
  return null;
}

/**
 * Geocode: Amap in CN context when key exists; Nominatim with en, then zh.
 */
async function geocodeForFactory(location: string): Promise<{
  lat?: number;
  lng?: number;
  locationZh?: string;
  useAmapRouting: boolean;
  geocoded: boolean;
}> {
  const tryChina = isLikelyChinaFromText(location) || hasAmapConfigured();
  if (tryChina) {
    const a = await amapGeocodeAddress(location);
    if (a) {
      return {
        lat: a.lat,
        lng: a.lng,
        locationZh: a.formattedAddress,
        useAmapRouting: isGcjInChinaBbox(a.lng, a.lat),
        geocoded: true,
      };
    }
  }
  const en = await geocodeNominatim(location, "en");
  if (en) {
    return {
      lat: en.lat,
      lng: en.lng,
      locationZh: location,
      useAmapRouting: isGcjInChinaBbox(en.lng, en.lat) && hasAmapConfigured(),
      geocoded: true,
    };
  }
  const zh = await geocodeNominatim(location, "zh");
  if (zh) {
    return {
      lat: zh.lat,
      lng: zh.lng,
      locationZh: location,
      useAmapRouting: isGcjInChinaBbox(zh.lng, zh.lat) && hasAmapConfigured(),
      geocoded: true,
    };
  }
  return { geocoded: false, useAmapRouting: false, locationZh: location };
}

function clusterFactories(factories: FactoryLocation[], maxDistKm = 50): FactoryLocation[][] {
  const withCoords = factories.filter((f) => f.geocoded && f.lat != null && f.lng != null);
  const noCoords = factories.filter((f) => !f.geocoded || f.lat == null || f.lng == null);
  const clusters: FactoryLocation[][] = [];
  const used = new Set<number>();

  for (const f of withCoords) {
    if (used.has(f.factoryId)) continue;
    const cluster: FactoryLocation[] = [f];
    used.add(f.factoryId);

    for (const other of withCoords) {
      if (used.has(other.factoryId)) continue;
      if (haversineDistance(f.lat!, f.lng!, other.lat!, other.lng!) <= maxDistKm) {
        cluster.push(other);
        used.add(other.factoryId);
      }
    }
    clusters.push(cluster);
  }

  if (noCoords.length) {
    clusters.push(noCoords);
  }
  return clusters.sort((a, b) => b.length - a.length);
}

function toPgTime(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

function timeToMinutes(h: number, m: number): number {
  return h * 60 + m;
}

type ExistingStop = { travelDate: string; startMin: number; endMin: number };

function intervalsOverlap(
  a0: number,
  a1: number,
  b0: number,
  b1: number
): boolean {
  return a0 < b1 && b0 < a1;
}

export async function loadExistingVisitBusyIntervals(
  userId: string,
  fromDate: string,
  toDate: string
): Promise<ExistingStop[]> {
  const { data, error } = await supabaseAdmin
    .from("visit_plans")
    .select("travel_date, visit_stops(scheduled_time, confirmation_status)")
    .eq("user_id", userId)
    .gte("travel_date", fromDate)
    .lte("travel_date", toDate);

  if (error || !data) {
    console.warn("[VisitPlanner] load existing stops failed:", error?.message);
    return [];
  }
  const out: ExistingStop[] = [];
  for (const p of data as Array<{
    travel_date: string;
    visit_stops: Array<{ scheduled_time: string | null; confirmation_status?: string }> | null;
  }>) {
    const day = p.travel_date;
    for (const s of p.visit_stops || []) {
      if (s.confirmation_status && s.confirmation_status !== "confirmed") continue;
      const t = s.scheduled_time;
      if (!t || typeof t !== "string") continue;
      const m = t.match(/^(\d{1,2}):(\d{2})/);
      if (!m) continue;
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const start = timeToMinutes(h, min);
      out.push({ travelDate: day, startMin: start, endMin: start + 60 });
    }
  }
  return out;
}

function hasConflictWithExisting(
  day: string,
  intervals: Array<{ start: number; end: number }>,
  existing: ExistingStop[]
): { conflict: true; detail: string } | { conflict: false } {
  const onDay = existing.filter((e) => e.travelDate === day);
  for (const n of intervals) {
    for (const e of onDay) {
      if (intervalsOverlap(n.start, n.end, e.startMin, e.endMin)) {
        return {
          conflict: true,
          detail: "This schedule overlaps with an existing visit. Change the start date or remove a conflicting plan.",
        };
      }
    }
  }
  return { conflict: false };
}

function hasInternalOverlap(intervals: Array<{ start: number; end: number }>): boolean {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (intervalsOverlap(sorted[i - 1].start, sorted[i - 1].end, sorted[i].start, sorted[i].end)) {
      return true;
    }
  }
  return false;
}

export async function resolvePlanningMatches(
  userId: string,
  input: { matchIds?: string[]; factoryIds?: number[] }
): Promise<{ ok: true; rows: ResolvedFactoryRow[] } | { ok: false; error: string; code: string }> {
  if (input.matchIds?.length) {
    const ids = [...new Set(input.matchIds)];
    if (ids.length !== input.matchIds.length) {
      return { ok: false, error: "Duplicate match_id in the request.", code: "DUPLICATE_MATCH" };
    }
    const { data, error } = await supabaseAdmin
      .from("matches")
      .select(
        "id, factory_id, status, context_summary, project_id, created_at, projects!inner(id, title, user_id)"
      )
      .in("id", ids);
    if (error) {
      return { ok: false, error: error.message, code: "DB_ERROR" };
    }
    const rows = (data || []) as Array<{
      id: string;
      factory_id: number;
      status: string;
      context_summary: unknown;
      project_id: string;
      projects: { id: string; title: string; user_id: string } | { id: string; title: string; user_id: string }[];
    }>;
    if (rows.length !== ids.length) {
      return { ok: false, error: "One or more matches are invalid or you do not have access.", code: "INVALID_MATCH" };
    }
    const byId = new Map(rows.map((m) => [m.id, m] as const));
    const seenFactory = new Set<number>();
    const out: ResolvedFactoryRow[] = [];
    for (const id of input.matchIds) {
      const m = byId.get(id);
      if (!m) {
        return { ok: false, error: "One or more matches are invalid or you do not have access.", code: "INVALID_MATCH" };
      }
      const proj = Array.isArray(m.projects) ? m.projects[0] : m.projects;
      if (proj.user_id !== userId) {
        return { ok: false, error: "One or more matches are invalid or you do not have access.", code: "INVALID_MATCH" };
      }
      if (DISALLOWED_MATCH_STATUSES.has(m.status)) {
        return {
          ok: false,
          error: `Match ${m.id} is not in a plannable state (${m.status}).`,
          code: "MATCH_NOT_ALLOWED",
        };
      }
      if (seenFactory.has(m.factory_id)) {
        return { ok: false, error: "Duplicate factory in selected matches. Remove duplicates.", code: "DUPLICATE_FACTORY" };
      }
      seenFactory.add(m.factory_id);
      out.push({
        matchId: m.id,
        factoryId: m.factory_id,
        projectId: m.project_id,
        projectTitle: proj.title || "Project",
        contextSummary: (m.context_summary as Record<string, unknown>) || {},
      });
    }
    return { ok: true, rows: out };
  }

  if (input.factoryIds?.length) {
    const fids = [...new Set(input.factoryIds)];
    const { data, error } = await supabaseAdmin
      .from("matches")
      .select(
        "id, factory_id, status, context_summary, project_id, created_at, projects!inner(id, title, user_id)"
      )
      .in("factory_id", fids)
      .eq("projects.user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      return { ok: false, error: error.message, code: "DB_ERROR" };
    }
    const all = (data || []) as unknown as Array<{
      id: string;
      factory_id: number;
      status: string;
      context_summary: unknown;
      project_id: string;
      created_at: string;
      projects: { title: string; user_id: string } | { title: string; user_id: string }[];
    }>;
    const byFactory = new Map<number, (typeof all)[0]>();
    for (const m of all) {
      if (DISALLOWED_MATCH_STATUSES.has(m.status)) continue;
      if (!byFactory.has(m.factory_id)) {
        byFactory.set(m.factory_id, m);
      }
    }
    const out: ResolvedFactoryRow[] = [];
    for (const fid of fids) {
      const m = byFactory.get(fid);
      if (!m) {
        return {
          ok: false,
          error: `No active match found for factory ${fid}. Add the factory via a project connection first.`,
          code: "FACTORY_UNMATCHED",
        };
      }
      const proj = Array.isArray(m.projects) ? m.projects[0] : m.projects;
      out.push({
        matchId: m.id,
        factoryId: m.factory_id,
        projectId: m.project_id,
        projectTitle: proj?.title || "Project",
        contextSummary: (m.context_summary as Record<string, unknown>) || {},
      });
    }
    return { ok: true, rows: out };
  }

  return { ok: false, error: "Provide match_ids (preferred) or factory_ids, plus start_date.", code: "INPUT_REQUIRED" };
}

async function optimizeClusterOrder(
  cluster: FactoryLocation[]
): Promise<FactoryLocation[]> {
  if (cluster.length <= 1) return cluster;
  const geo = cluster.filter((c) => c.lat != null && c.lng != null);
  if (geo.length <= 1) return cluster;
  const points = geo.map((c, i) => ({
    lng: c.lng!,
    lat: c.lat!,
    idx: i,
  }));
  const useAmap = geo.some((c) => c.useAmapRouting) && hasAmapConfigured();
  if (!useAmap) {
    const route: FactoryLocation[] = [cluster[0]];
    const remaining = cluster.slice(1);
    while (remaining.length) {
      const last = route[route.length - 1];
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversineDistance(last.lat!, last.lng!, remaining[i].lat!, remaining[i].lng!);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      route.push(remaining.splice(bi, 1)[0]!);
    }
    return route;
  }
  const orderIdx = await orderStopsByDrivingHeuristic(points);
  const reordered: FactoryLocation[] = [];
  for (const oi of orderIdx) {
    reordered.push(cluster[oi]!);
  }
  return reordered;
}

export async function planVisits(
  userId: string,
  input: PlanVisitsInput
): Promise<PlanResult & { _error?: { message: string; code: string } }> {
  const resolved = await resolvePlanningMatches(userId, { matchIds: input.matchIds, factoryIds: input.factoryIds });
  if (!resolved.ok) {
    return { plans: [], warnings: [], _error: { message: resolved.error, code: resolved.code } };
  }
  const rows = resolved.rows;
  const factoryIds = rows.map((r) => r.factoryId);

  const { data: factories, error: facErr } = await supabaseAdmin
    .from("factories")
    .select("id, name, location")
    .in("id", factoryIds);
  if (facErr) {
    return { plans: [], warnings: [], _error: { message: facErr.message, code: "DB_ERROR" } };
  }
  const fmap = new Map((factories || []).map((f) => [f.id, f] as const));

  const globalWarnings: string[] = [];
  const locations: FactoryLocation[] = [];
  let i = 0;
  for (const r of rows) {
    const f = fmap.get(r.factoryId);
    if (!f) {
      return { plans: [], warnings: [], _error: { message: "Factory not found.", code: "NOT_FOUND" } };
    }
    const g = await geocodeForFactory(f.location);
    if (!g.geocoded) {
      globalWarnings.push(
        `Could not place "${f.name}" on the map from its address. It is still scheduled; confirm the location in 高德/Maps before you travel.`
      );
    }
    locations.push({
      idx: i++,
      factoryId: f.id,
      matchId: r.matchId,
      name: f.name,
      location: f.location,
      projectTitle: r.projectTitle,
      lat: g.lat,
      lng: g.lng,
      locationZh: g.locationZh || f.location,
      geocoded: g.geocoded,
      useAmapRouting: g.useAmapRouting,
    });
  }

  const clusters = clusterFactories(locations);
  const workEndMin = 17 * 60;
  const visitMin = 60;
  const baseDate = new Date(input.startDate);
  if (Number.isNaN(baseDate.getTime())) {
    return { plans: [], warnings: globalWarnings, _error: { message: "Invalid start_date.", code: "INVALID_DATE" } };
  }

  const nDays = clusters.length;
  if (nDays === 0) {
    return { plans: [], warnings: globalWarnings };
  }
  const startStr = input.startDate.split("T")[0] || input.startDate;
  const endD = new Date(baseDate);
  endD.setDate(endD.getDate() + nDays + 2);
  const endStr = endD.toISOString().split("T")[0]!;
  const existingBusy: ExistingStop[] = [...(await loadExistingVisitBusyIntervals(userId, startStr, endStr))];

  const anthropic = getAnthropicClient();
  const clusterForAi = await Promise.all(
    clusters.map(async (c) => {
      const ordered = await optimizeClusterOrder(c);
      return ordered;
    })
  );

  const aiPayload = clusterForAi.map((c, i) => ({
    day: i + 1,
    region_hint: c[0]?.location.split(",").pop()?.trim() || "China",
    stops: c.map((f) => ({
      factory_id: f.factoryId,
      name: f.name,
      location: f.location,
      project: f.projectTitle,
    })),
  }));

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system:
      "You are a travel logistics planner for factory visits. You receive ordered daily clusters. " +
      "Return ONLY a JSON object of shape { \"days\": [ { \"day_index\": 1, \"slots\": [ { \"factory_id\": number, \"notes\": string } ] } ] }. " +
      "factory_id must be the exact integer from input. Notes: one short English line per stop (visit focus or question).",
    messages: [
      {
        role: "user",
        content: `Plan visit times starting from ${input.startDate} (day 1 = first travel day). Data:\n${JSON.stringify(
          aiPayload
        )}`,
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  let parsed: { days?: Array<{ day_index?: number; slots?: Array<{ factory_id: number; notes?: string; suggested_time?: string }> }> } = {};
  try {
    parsed = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim());
  } catch {
    parsed = {};
  }

  const daySlots = new Map<number, Map<number, { notes?: string }>>();
  for (const d of parsed.days || []) {
    const di = typeof d.day_index === "number" ? d.day_index : 0;
    if (di < 1) continue;
    const m = new Map<number, { notes?: string }>();
    for (const s of d.slots || []) {
      const fid = s.factory_id;
      if (typeof fid === "number" && Number.isInteger(fid)) {
        m.set(fid, { notes: typeof s.notes === "string" ? s.notes : undefined });
      }
    }
    daySlots.set(di, m);
  }

  const plans: PlanResult["plans"] = [];

  for (let i = 0; i < clusterForAi.length; i++) {
    const cluster = clusterForAi[i]!;
    const dayIndex = i + 1;
    const date = new Date(baseDate.getTime() + i * 86400000).toISOString().split("T")[0]!;
    const region = cluster[0]?.location.split(",").pop()?.trim() || "China";
    const slotMap = daySlots.get(dayIndex) || new Map();
    const routeOrdered = cluster;

    let cursor = 9 * 60;
    const newDayIntervals: Array<{ start: number; end: number }> = [];
    const stopsOut: PlanResult["plans"][0]["stops"] = [];
    const matchIds: string[] = [];
    const projectTitles: string[] = [];
    const fids: number[] = [];

    for (let j = 0; j < routeOrdered.length; j++) {
      const f = routeOrdered[j]!;
      if (j > 0) {
        const prev = routeOrdered[j - 1]!;
        let travelMin = 30;
        if (prev.lat != null && prev.lng != null && f.lat != null && f.lng != null) {
          if (prev.useAmapRouting && f.useAmapRouting) {
            const leg = await amapDrivingLeg(
              { lng: prev.lng, lat: prev.lat },
              { lng: f.lng, lat: f.lat }
            );
            if (leg) {
              travelMin = Math.max(1, Math.ceil(leg.durationSec / 60));
            } else {
              travelMin = Math.max(15, Math.ceil(haversineDistance(prev.lat, prev.lng, f.lat, f.lng) * 3));
            }
          } else {
            travelMin = Math.max(15, Math.ceil(haversineDistance(prev.lat, prev.lng, f.lat, f.lng) * 3));
          }
        }
        cursor += travelMin;
      }

      const startMin = Math.max(cursor, 9 * 60);
      if (startMin + visitMin > workEndMin) {
        return {
          plans: [],
          warnings: globalWarnings,
          _error: {
            message: `Not enough time in the day for all visits on ${date}. Start earlier, split across more days, or remove a stop.`,
            code: "SCHEDULE_OVERFLOW",
          },
        };
      }
      const endMin = startMin + visitMin;
      cursor = endMin;
      newDayIntervals.push({ start: startMin, end: endMin });
      fids.push(f.factoryId);
      if (!matchIds.includes(f.matchId)) matchIds.push(f.matchId);
      if (!projectTitles.includes(f.projectTitle)) projectTitles.push(f.projectTitle);
      const zh = f.locationZh || f.location;
      const amapUrl =
        f.lng != null && f.lat != null
          ? `https://uri.amap.com/marker?position=${f.lng},${f.lat}&name=${encodeURIComponent(f.name).slice(0, 200)}`
          : undefined;
      const noteFromAi = slotMap.get(f.factoryId)?.notes?.trim().slice(0, 2000) || "";
      stopsOut.push({
        factoryId: f.factoryId,
        matchId: f.matchId,
        name: f.name,
        time: toPgTime(Math.floor(startMin / 60), startMin % 60),
        locationZh: zh,
        amapUrl,
        projectTitle: f.projectTitle,
        notes: noteFromAi || undefined,
        lat: f.lat,
        lng: f.lng,
      });
    }

    if (hasInternalOverlap(newDayIntervals)) {
      return {
        plans: [],
        warnings: globalWarnings,
        _error: { message: "Generated schedule has overlapping visit windows. Try a different start date or fewer stops per day.", code: "INTERNAL_OVERLAP" },
      };
    }
    const ex = hasConflictWithExisting(date, newDayIntervals, existingBusy);
    if (ex.conflict) {
      return { plans: [], warnings: globalWarnings, _error: { message: ex.detail, code: "SCHEDULE_CONFLICT" } };
    }

    const { data: plan, error: perr } = await supabaseAdmin
      .from("visit_plans")
      .insert({
        user_id: userId,
        travel_date: date,
        region,
        route: {
          match_ids: matchIds,
          project_titles: projectTitles,
          factory_ids: fids,
          amap: routeOrdered.some((r) => r.useAmapRouting) && hasAmapConfigured(),
          stop_details: stopsOut.map((s) => {
            const has = s.lat != null && s.lng != null;
            return {
              factory_id: s.factoryId,
              match_id: s.matchId,
              location_zh: s.locationZh,
              amap_url: s.amapUrl,
              project_title: s.projectTitle,
              lat: has ? s.lat! : null,
              lng: has ? s.lng! : null,
            };
          }),
        },
      })
      .select("id")
      .single();

    if (perr || !plan) {
      return { plans: [], warnings: globalWarnings, _error: { message: perr?.message || "Could not save plan", code: "DB_ERROR" } };
    }

    for (const stop of stopsOut) {
      const { error: serr } = await supabaseAdmin.from("visit_stops").insert({
        plan_id: plan.id,
        factory_id: stop.factoryId,
        match_id: stop.matchId,
        scheduled_time: stop.time,
        status: "planned",
        notes: stop.notes || "",
        confirmation_status: "draft",
      });
      if (serr) {
        await supabaseAdmin.from("visit_plans").delete().eq("id", plan.id);
        return { plans: [], warnings: globalWarnings, _error: { message: serr.message, code: "DB_ERROR" } };
      }
    }

    for (const iv of newDayIntervals) {
      existingBusy.push({ travelDate: date, startMin: iv.start, endMin: iv.end });
    }

    const routeWarnings = !cluster.some((c) => c.geocoded) ? ["Stops on this day need location confirmation."] : undefined;
    plans.push({
      date,
      region,
      route: {
        match_ids: matchIds,
        project_titles: projectTitles,
        factory_ids: fids,
        amap: routeOrdered.some((r) => r.useAmapRouting) && hasAmapConfigured(),
        warnings: routeWarnings,
        stop_details: stopsOut.map((s) => {
          const has = s.lat != null && s.lng != null;
          return {
            factory_id: s.factoryId,
            match_id: s.matchId,
            location_zh: s.locationZh,
            amap_url: s.amapUrl,
            project_title: s.projectTitle,
            lat: has ? s.lat! : null,
            lng: has ? s.lng! : null,
          };
        }),
      },
      stops: stopsOut,
    });
  }

  return { plans, warnings: globalWarnings };
}

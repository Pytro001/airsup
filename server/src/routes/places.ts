import { Router } from "express";
import type { Request, Response } from "express";

/**
 * Public place search for location autocomplete (OpenStreetMap Nominatim).
 * @see https://operations.osmfoundation.org/policies/nominatim/ — one request/second; client debounce helps.
 * @see https://nominatim.org/release-docs/develop/api/Search/
 */
export const placesRouter = Router();

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const MAX_OUT = 3;
const CANDIDATE_LIMIT = 10;

type NominatimRow = {
  display_name?: string;
  importance?: number;
  class?: string;
  type?: string;
  address?: Record<string, string | undefined>;
};

function asStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  return String(v);
}

function buildShortLabel(d: NominatimRow): string {
  const a = d.address || {};
  const city = asStr(a.city) || asStr(a.town) || asStr(a.village) || asStr(a.municipality) || "";
  const state = asStr(a.state) || asStr(a.state_district) || asStr(a.region) || asStr(a.county) || "";
  const country = asStr(a.country) || "";
  const parts: string[] = [];
  if (city) parts.push(city);
  if (state && state !== city) parts.push(state);
  if (country) parts.push(country);
  const uniq = [...new Set(parts.filter(Boolean))];
  if (uniq.length) return uniq.join(", ");
  if (state && country) return `${state}, ${country}`;
  if (country) return country;
  if (state) return state;
  if (d.display_name) {
    const segs = d.display_name
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segs.length >= 2) {
      return segs.slice(0, 2).join(", ");
    }
    return d.display_name.slice(0, 90);
  }
  return "";
}

function skipNonPlace(d: NominatimRow): boolean {
  const a = d.address || {};
  const c = d.class || "";
  const hasNamedPlace = !!(a.city || a.town || a.village || a.municipality || a.state || a.country);
  if ((c === "shop" || c === "tourism" || c === "amenity" || c === "building") && !hasNamedPlace) {
    return true;
  }
  return false;
}

function normKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

function processNominatimJson(data: NominatimRow[]): { label: string; importance: number }[] {
  const rows: { label: string; importance: number; row: NominatimRow }[] = [];
  for (const d of data) {
    if (!d) continue;
    if (skipNonPlace(d)) continue;
    const label = buildShortLabel(d);
    if (!label) continue;
    const importance = typeof d.importance === "number" && !Number.isNaN(d.importance) ? d.importance : 0;
    rows.push({ label, importance, row: d });
  }
  rows.sort((a, b) => b.importance - a.importance);
  const seen = new Set<string>();
  const out: { label: string; importance: number }[] = [];
  for (const r of rows) {
    const k = normKey(r.label);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label: r.label, importance: r.importance });
    if (out.length >= MAX_OUT) break;
  }
  return out;
}

async function fetchNominatim(
  q: string,
  opts: { featureType?: "settlement"; signal?: AbortSignal }
): Promise<NominatimRow[]> {
  const url = new URL(NOMINATIM);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(CANDIDATE_LIMIT));
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "en,de,es,fr,zh,ja,ko,pt,ru,hi,ar");
  if (opts.featureType) {
    url.searchParams.set("featureType", opts.featureType);
  }
  const r = await fetch(url.toString(), {
    signal: opts.signal,
    headers: {
      "User-Agent": "Airsup/1.0 (https://airsup.dev)",
      Accept: "application/json",
    },
  });
  if (!r.ok) return [];
  const data = (await r.json()) as unknown;
  return Array.isArray(data) ? (data as NominatimRow[]) : [];
}

placesRouter.get("/autocomplete", async (req: Request, res: Response) => {
  const q = String(req.query.q || "")
    .trim()
    .slice(0, 200);
  if (q.length < 2) {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ results: [] as { label: string }[] });
    return;
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const sig = ac.signal;
    let raw = await fetchNominatim(q, { featureType: "settlement", signal: sig });
    let processed = processNominatimJson(raw);
    if (processed.length === 0) {
      raw = await fetchNominatim(q, { signal: sig });
      processed = processNominatimJson(raw);
    }
    const results = processed.slice(0, MAX_OUT).map(({ label }) => ({ label }));
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ results });
  } catch (e) {
    console.error("[places] autocomplete:", e);
    res.setHeader("Cache-Control", "no-store");
    res.json({ results: [] });
  } finally {
    clearTimeout(t);
  }
});

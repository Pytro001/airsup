import { Router } from "express";
import type { Request, Response } from "express";

/**
 * Public place search for location autocomplete (OpenStreetMap Nominatim).
 * @see https://operations.osmfoundation.org/policies/nominatim/ — one request/second; client debounce helps.
 */
export const placesRouter = Router();

placesRouter.get("/autocomplete", async (req: Request, res: Response) => {
  const q = String(req.query.q || "")
    .trim()
    .slice(0, 200);
  if (q.length < 2) {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ results: [] as { label: string }[] });
    return;
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "8");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "en,de,es,fr,zh,ja,ko,pt,ru,hi,ar");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(url.toString(), {
      signal: ac.signal,
      headers: {
        "User-Agent": "Airsup/1.0 (https://airsup.dev)",
        Accept: "application/json",
      },
    });
    if (!r.ok) {
      res.setHeader("Cache-Control", "no-store");
      res.json({ results: [] });
      return;
    }
    const data = (await r.json()) as Array<{ display_name?: string }>;
    const list = Array.isArray(data) ? data : [];
    const results = list
      .map((d) => (typeof d.display_name === "string" ? { label: d.display_name } : null))
      .filter((x): x is { label: string } => x != null && x.label.length > 0);
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

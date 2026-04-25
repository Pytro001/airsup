/**
 * Amap 高德 (Gaode) web API for mainland China: GCJ-02 coordinates.
 * Set AMAP_WEB_KEY in the server environment. If unset, callers should fall back to Nominatim + Haversine.
 * @see https://lbs.amap.com/api/webservice/summary
 */

const AMAP_BASE = "https://restapi.amap.com/v3";

export function isGcjInChinaBbox(lng: number, lat: number): boolean {
  return lng >= 72 && lng <= 136 && lat >= 17 && lat <= 55;
}

export function isLikelyChinaFromText(location: string): boolean {
  const s = location.trim();
  if (!s) return false;
  if (/\b(CN|China|PRC|Mainland)\b/i.test(s)) return true;
  // Common 中文 / regional markers
  if (/[\u4e00-\u9fff]/.test(s)) return true;
  if (/\b(Guangdong|Zhejiang|Jiangsu|Fujian|Sichuan|Shanghai|Beijing|Shenzhen|Guangzhou|Hangzhou|Ningbo|Dongguan|Chengdu|Chongqing|Wuhan|Qingdao|Xi'an|Xian|Shantou|Zhuhai|Foshan)\b/i.test(s)) {
    return true;
  }
  return false;
}

function getAmapKey(): string | null {
  const k = process.env.AMAP_WEB_KEY || process.env.AMAP_KEY;
  return k?.trim() || null;
}

export interface AmapGeocodeResult {
  lng: number;
  lat: number;
  formattedAddress: string;
}

/**
 * Geocode a free-text address; returns GCJ-02 lng/lat.
 */
export async function amapGeocodeAddress(address: string): Promise<AmapGeocodeResult | null> {
  const key = getAmapKey();
  if (!key || !address.trim()) return null;
  const url = `${AMAP_BASE}/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(address.trim())}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const data = (await res.json()) as { status: string; geocodes?: Array<{ location: string; formatted_address: string }> };
    if (data.status !== "1" || !data.geocodes?.length) return null;
    const [lngS, latS] = data.geocodes[0].location.split(",").map((x) => parseFloat(x.trim()));
    if (!Number.isFinite(lngS) || !Number.isFinite(latS)) return null;
    return {
      lng: lngS,
      lat: latS,
      formattedAddress: data.geocodes[0].formatted_address || address.trim(),
    };
  } catch (e) {
    console.warn("[Amap] geocode failed:", e);
    return null;
  }
}

export interface AmapLeg {
  /** Driving distance, metres */
  distanceM: number;
  /** Driving duration, seconds */
  durationSec: number;
}

/**
 * One origin, one destination; type=1 is driving.
 */
export async function amapDrivingLeg(origin: { lng: number; lat: number }, dest: { lng: number; lat: number }): Promise<AmapLeg | null> {
  const key = getAmapKey();
  if (!key) return null;
  const origins = `${origin.lng},${origin.lat}`;
  const destination = `${dest.lng},${dest.lat}`;
  const url = `${AMAP_BASE}/distance?key=${encodeURIComponent(key)}&origins=${origins}&destination=${encodeURIComponent(
    destination
  )}&type=1`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const data = (await res.json()) as { status: string; results?: Array<{ distance: string; duration: string }> };
    if (data.status !== "1" || !data.results?.length) return null;
    const d = data.results[0];
    const distanceM = parseFloat(d.distance);
    const durationSec = parseFloat(d.duration) / 1; // API returns seconds for distance API v3? Check: docs say 秒
    if (!Number.isFinite(distanceM) || !Number.isFinite(durationSec)) return null;
    return { distanceM, durationSec };
  } catch (e) {
    console.warn("[Amap] distance/driving leg failed:", e);
    return null;
  }
}

/**
 * Greedily order points by next-shortest Amap driving duration from the current stop.
 * Falls back to Haversine (km) when Amap returns null.
 */
export async function orderStopsByDrivingHeuristic(
  points: { lng: number; lat: number; idx: number }[]
): Promise<number[]> {
  if (points.length <= 1) return points.map((p) => p.idx);

  const R = 6371;
  function haversineKm(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const l1 = (a.lat * Math.PI) / 180;
    const l2 = (b.lat * Math.PI) / 180;
    const s =
      Math.sin(dLat / 2) ** 2 + Math.cos(l1) * Math.cos(l2) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  const order: number[] = [];
  const remaining = [...points];
  let current = remaining.shift()!;
  order.push(current.idx);
  const key = getAmapKey();
  const useAmap = !!key;

  while (remaining.length) {
    let bestI = 0;
    let bestScore = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let sec: number | null = null;
      if (useAmap && isGcjInChinaBbox(current.lng, current.lat) && isGcjInChinaBbox(cand.lng, cand.lat)) {
        const leg = await amapDrivingLeg(
          { lng: current.lng, lat: current.lat },
          { lng: cand.lng, lat: cand.lat }
        );
        if (leg) sec = leg.durationSec;
      }
      const score = sec != null && Number.isFinite(sec) ? sec : haversineKm(current, cand) * 120;
      if (score < bestScore) {
        bestScore = score;
        bestI = i;
      }
    }
    current = remaining.splice(bestI, 1)[0]!;
    order.push(current.idx);
  }
  return order;
}

/**
 * Amap / 高德 marker deep link (GCJ-02).
 */
export function amapWebMarkerUrl(lng: number, lat: number, name: string): string {
  const q = new URLSearchParams();
  q.set("position", `${lng},${lat}`);
  if (name) q.set("name", name.slice(0, 200));
  return `https://uri.amap.com/marker?${q.toString()}`;
}

export function hasAmapConfigured(): boolean {
  return !!getAmapKey();
}

import { getAnthropicClient } from "../services/anthropic.js";
import { supabaseAdmin } from "../services/supabase.js";

interface FactoryLocation {
  factoryId: number;
  name: string;
  location: string;
  lat?: number;
  lng?: number;
}

async function geocodeLocation(location: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
      { headers: { "User-Agent": "Airsup/1.0", "Accept-Language": "en" } }
    );
    const data = await res.json();
    if (data?.[0]) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (err) {
    console.warn("[VisitPlanner] geocode failed:", err);
  }
  return null;
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clusterFactories(factories: FactoryLocation[], maxDistKm = 50): FactoryLocation[][] {
  const clusters: FactoryLocation[][] = [];
  const used = new Set<number>();

  for (const f of factories) {
    if (used.has(f.factoryId) || !f.lat || !f.lng) continue;
    const cluster: FactoryLocation[] = [f];
    used.add(f.factoryId);

    for (const other of factories) {
      if (used.has(other.factoryId) || !other.lat || !other.lng) continue;
      if (haversineDistance(f.lat, f.lng, other.lat, other.lng) <= maxDistKm) {
        cluster.push(other);
        used.add(other.factoryId);
      }
    }
    clusters.push(cluster);
  }

  return clusters.sort((a, b) => b.length - a.length);
}

function optimizeRoute(factories: FactoryLocation[]): FactoryLocation[] {
  if (factories.length <= 2) return factories;

  const route: FactoryLocation[] = [factories[0]];
  const remaining = [...factories.slice(1)];

  while (remaining.length > 0) {
    const last = route[route.length - 1];
    let nearest = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const d = haversineDistance(last.lat!, last.lng!, remaining[i].lat!, remaining[i].lng!);
      if (d < nearestDist) {
        nearest = i;
        nearestDist = d;
      }
    }

    route.push(remaining.splice(nearest, 1)[0]);
  }

  return route;
}

export async function planVisits(
  userId: string,
  factoryIds: number[],
  startDate: string
): Promise<{ plans: Array<{ date: string; region: string; stops: Array<{ factoryId: number; name: string; time: string }> }> }> {
  const { data: factories } = await supabaseAdmin
    .from("factories")
    .select("id, name, location")
    .in("id", factoryIds);

  if (!factories?.length) return { plans: [] };

  const locations: FactoryLocation[] = [];
  for (const f of factories) {
    const coords = await geocodeLocation(f.location);
    locations.push({
      factoryId: f.id,
      name: f.name,
      location: f.location,
      lat: coords?.lat,
      lng: coords?.lng,
    });
  }

  const clusters = clusterFactories(locations);

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: "You are a travel logistics planner for factory visits in China. Given factory clusters grouped by proximity, assign time slots. Factories open 9:00-17:00 local time. Allow 1 hour per visit plus 30 min travel between nearby factories. Respond with JSON array of { factory_id, suggested_time, notes }.",
    messages: [
      {
        role: "user",
        content: `Plan visits starting ${startDate}.\n\nClusters:\n${clusters
          .map(
            (c, i) =>
              `Day ${i + 1}: ${c.map((f) => `${f.name} (${f.location})`).join(", ")}`
          )
          .join("\n")}`,
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "[]";
  let schedule;
  try {
    schedule = JSON.parse(text.replace(/```json\n?/g, "").replace(/```/g, "").trim());
  } catch {
    schedule = [];
  }

  const plans: Array<{ date: string; region: string; stops: Array<{ factoryId: number; name: string; time: string }> }> = [];
  const baseDate = new Date(startDate);

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const routeOrdered = optimizeRoute(cluster);
    const date = new Date(baseDate.getTime() + i * 86400000).toISOString().split("T")[0];
    const region = cluster[0]?.location.split(",").pop()?.trim() || "China";

    const stops = routeOrdered.map((f, j) => {
      const scheduleEntry = (schedule as any[])?.find((s: any) => s.factory_id === f.factoryId);
      const hour = 9 + j * 1.5;
      const time = scheduleEntry?.suggested_time || `${Math.floor(hour)}:${hour % 1 ? "30" : "00"}`;
      return { factoryId: f.factoryId, name: f.name, time };
    });

    const { data: plan } = await supabaseAdmin
      .from("visit_plans")
      .insert({ user_id: userId, travel_date: date, region, route: { optimized: routeOrdered.map((f) => f.factoryId) } })
      .select("id")
      .single();

    if (plan) {
      for (const stop of stops) {
        await supabaseAdmin.from("visit_stops").insert({
          plan_id: plan.id,
          factory_id: stop.factoryId,
          scheduled_time: stop.time,
          status: "planned",
        });
      }
    }

    plans.push({ date, region, stops });
  }

  return { plans };
}

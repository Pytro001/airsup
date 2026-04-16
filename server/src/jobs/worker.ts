import { supabaseAdmin } from "../services/supabase.js";
import { runFactorySearch } from "../agents/search.js";
import { runNegotiation } from "../agents/negotiate.js";
import { processMatch } from "../agents/match.js";

const POLL_INTERVAL = 15_000;

async function processPendingSearches(): Promise<void> {
  const { data: searches } = await supabaseAdmin
    .from("factory_searches")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);

  for (const search of searches || []) {
    try {
      console.log(`[Worker] Running factory search ${search.id}`);
      await runFactorySearch(search.id);
    } catch (err) {
      console.error(`[Worker] Search ${search.id} failed:`, err);
      await supabaseAdmin.from("factory_searches").update({ status: "failed" }).eq("id", search.id);
    }
  }
}

async function processBriefedOutreach(): Promise<void> {
  const { data: outreach } = await supabaseAdmin
    .from("outreach_logs")
    .select("id")
    .eq("stage", "briefed")
    .order("created_at", { ascending: true })
    .limit(5);

  for (const o of outreach || []) {
    try {
      console.log(`[Worker] Negotiating outreach ${o.id}`);
      await runNegotiation(o.id);
    } catch (err) {
      console.error(`[Worker] Negotiation ${o.id} failed:`, err);
    }
  }
}

async function processPendingMatches(): Promise<void> {
  const { data: matches } = await supabaseAdmin
    .from("matches")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);

  for (const m of matches || []) {
    try {
      console.log(`[Worker] Processing match intro ${m.id}`);
      await processMatch(m.id);
    } catch (err) {
      console.error(`[Worker] Match ${m.id} failed:`, err);
    }
  }
}

async function processTimelineChecks(): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  await supabaseAdmin
    .from("timelines")
    .update({ status: "overdue" })
    .eq("status", "upcoming")
    .lt("due_date", today);

  await supabaseAdmin
    .from("timelines")
    .update({ status: "at_risk" })
    .eq("status", "upcoming")
    .lte("due_date", new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0]);
}

async function poll(): Promise<void> {
  try {
    await processPendingSearches();
    await processBriefedOutreach();
    await processPendingMatches();
    await processTimelineChecks();
  } catch (err) {
    console.error("[Worker] poll error:", err);
  }
}

export function startWorker(): void {
  console.log(`[Worker] Starting job poller (every ${POLL_INTERVAL / 1000}s)`);
  poll();
  setInterval(poll, POLL_INTERVAL);
}

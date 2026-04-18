import { supabaseAdmin } from "../services/supabase.js";
import { runFactorySearch } from "../agents/search.js";
import { runNegotiation } from "../agents/negotiate.js";
import { processMatch } from "../agents/match.js";

/**
 * One pass of the background queues (search → negotiate → match intros → timelines).
 * Safe to call from Vercel cron or the long-running server worker.
 *
 * Matching pipeline: factory_searches (pending) → runFactorySearch → outreach_logs (briefed)
 * → runNegotiation → outreach_logs (await_supplier) + pending_match
 * → supplier POST /api/outreach/:id/accept → matches (pending) → processMatch → buyer Connections.
 * On Vercel use GET/POST /api/internal/jobs with CRON_SECRET; otherwise startWorker() polls in server/src/index.ts.
 */
export async function runJobPollOnce(): Promise<void> {
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

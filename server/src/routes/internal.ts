import { Router } from "express";
import type { Response } from "express";
import { runJobPollOnce } from "../jobs/poll.js";
import { cleanupStaleAnonymousUsers } from "../jobs/cleanup-anonymous.js";
import { supabaseAdmin } from "../services/supabase.js";

export const internalRouter = Router();

/**
 * Background jobs for Vercel: vercel.json crons should hit GET /api/internal/jobs.
 *
 * Vercel Hobby only allows cron schedules that run once per day; more frequent
 * schedules fail deployment (see Vercel cron docs). For every-few-minutes jobs
 * on Hobby, use an external HTTP cron (e.g. cron-job.org) calling this route,
 * or upgrade to Pro and use a tighter schedule in vercel.json.
 *
 * Abandoned guest accounts (anonymous, no password / phone sign-in):
 * - GET/POST /api/internal/cleanup-anonymous — run hourly via external cron with
 *   Authorization: Bearer CRON_SECRET. Env: CLEANUP_ANON_HOURS (default 1) or
 *   CLEANUP_ANON_MINUTES (takes precedence for dev/testing). Hobby cannot run
 *   this hourly in vercel.json; use an external scheduler or Supabase scheduled function.
 *
 * Ops checklist (matching + uploads):
 * - CRON_SECRET: Vercel project env; cron requests include Authorization: Bearer <CRON_SECRET>
 * - SUPABASE_SERVICE_ROLE_KEY: service_role key (not anon); required for admin DB + Storage signing
 * - ANTHROPIC_API_KEY: intake, search scoring, negotiation, match intros
 * - Apply Supabase migrations through 018+ (Storage RLS 018_storage_rls_jwt_sub, etc.)
 * - Local / non-Vercel: server/src/index.ts runs startWorker(); or set RUN_JOB_POLL_AFTER_SEARCH=1 so intake can trigger runJobPollOnce after search_factories
 */
function authorizeCron(req: { headers: { authorization?: string } }): boolean {
  const secret = process.env.CRON_SECRET;
  // In local dev (no VERCEL env, no CRON_SECRET) allow unauthenticated calls.
  if (!secret) {
    return !process.env.VERCEL;
  }
  const auth = req.headers.authorization;
  return auth === `Bearer ${secret}`;
}

/**
 * Hard-delete rows from `profiles` and `factories` that have been in the bin
 * (soft-deleted) for more than 24 hours.
 */
async function purgeBin(): Promise<{ profiles: number; factories: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [profilesRes, factoriesRes] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .delete()
      .not("deleted_at", "is", null)
      .lt("deleted_at", cutoff)
      .select("id"),
    supabaseAdmin
      .from("factories")
      .delete()
      .not("deleted_at", "is", null)
      .lt("deleted_at", cutoff)
      .select("id"),
  ]);

  if (profilesRes.error) {
    console.error("[internal/purge-bin] profiles delete error:", profilesRes.error);
  }
  if (factoriesRes.error) {
    console.error("[internal/purge-bin] factories delete error:", factoriesRes.error);
  }

  return {
    profiles: profilesRes.data?.length ?? 0,
    factories: factoriesRes.data?.length ?? 0,
  };
}

async function runJobs(_req: unknown, res: Response): Promise<void> {
  try {
    await runJobPollOnce();
    const purged = await purgeBin();
    res.json({ ok: true, purged });
  } catch (err) {
    console.error("[internal/jobs]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Job run failed" });
  }
}

internalRouter.get("/jobs", (req, res) => {
  if (!authorizeCron(req)) {
    res.status(401).json({ error: "Unauthorized. Set CRON_SECRET and use Vercel cron or Bearer token" });
    return;
  }
  void runJobs(req, res);
});

internalRouter.post("/jobs", (req, res) => {
  if (!authorizeCron(req)) {
    res.status(401).json({ error: "Unauthorized. Set CRON_SECRET and use Vercel cron or Bearer token" });
    return;
  }
  void runJobs(req, res);
});

async function runCleanupAnonymous(_req: unknown, res: Response): Promise<void> {
  try {
    const result = await cleanupStaleAnonymousUsers();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[internal/cleanup-anonymous]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Cleanup failed" });
  }
}

internalRouter.get("/cleanup-anonymous", (req, res) => {
  if (!authorizeCron(req)) {
    res.status(401).json({ error: "Unauthorized. Set CRON_SECRET and use Bearer token" });
    return;
  }
  void runCleanupAnonymous(req, res);
});

internalRouter.post("/cleanup-anonymous", (req, res) => {
  if (!authorizeCron(req)) {
    res.status(401).json({ error: "Unauthorized. Set CRON_SECRET and use Bearer token" });
    return;
  }
  void runCleanupAnonymous(req, res);
});

internalRouter.post("/purge-bin", async (req, res) => {
  if (!authorizeCron(req)) {
    res.status(401).json({ error: "Unauthorized. Set CRON_SECRET and use Bearer token" });
    return;
  }
  try {
    const result = await purgeBin();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[internal/purge-bin]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Purge failed" });
  }
});

import { Router } from "express";
import type { Response } from "express";
import { runJobPollOnce } from "../jobs/poll.js";

export const internalRouter = Router();

/**
 * Background jobs for Vercel: vercel.json crons should hit GET /api/internal/jobs.
 *
 * Vercel Hobby only allows cron schedules that run once per day; more frequent
 * schedules fail deployment (see Vercel cron docs). For every-few-minutes jobs
 * on Hobby, use an external HTTP cron (e.g. cron-job.org) calling this route,
 * or upgrade to Pro and use a tighter schedule in vercel.json.
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

async function runJobs(_req: unknown, res: Response): Promise<void> {
  try {
    await runJobPollOnce();
    res.json({ ok: true });
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

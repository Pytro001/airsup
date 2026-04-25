import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { planVisits } from "../agents/visit-planner.js";
import { draftProposalsForVisitPlan } from "../agents/visit-negotiate.js";

export const visitsRouter = Router();

visitsRouter.post("/plan", requireAuth, async (req: AuthRequest, res: Response) => {
  const body = req.body as {
    factory_ids?: number[];
    match_ids?: string[];
    start_date?: string;
  };
  const { factory_ids, match_ids, start_date } = body;

  if (!start_date || (!factory_ids?.length && !match_ids?.length)) {
    res.status(400).json({
      error: "start_date and either match_ids (preferred) or factory_ids are required",
      code: "INPUT_REQUIRED",
    });
    return;
  }

  try {
    const result = await planVisits(req.userId!, {
      startDate: start_date,
      matchIds: match_ids,
      factoryIds: factory_ids,
    });
    if (result._error) {
      const code = result._error.code;
      const status =
        code === "DB_ERROR" ? 500 : code === "SCHEDULE_OVERFLOW" || code === "SCHEDULE_CONFLICT" ? 400 : 400;
      res.status(status).json({
        error: result._error.message,
        code: result._error.code,
        warnings: result.warnings,
      });
      return;
    }
    const { _error, ...out } = result;
    res.json(out);
  } catch (err) {
    console.error("[Visits] plan error:", err);
    res.status(500).json({ error: "Visit planning failed" });
  }
});

visitsRouter.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("visit_plans")
    .select(`
      id, travel_date, region, route, created_at,
      visit_stops(id, factory_id, match_id, scheduled_time, status, notes, factories(name, location))
    `)
    .eq("user_id", req.userId!)
    .order("travel_date", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ plans: data || [] });
});

/**
 * Bilingual message drafts for each stop on a plan (Phase 2). Buyer pastes or sends via connection chat.
 */
visitsRouter.post("/:id/propose-messages", requireAuth, async (req: AuthRequest, res: Response) => {
  const out = await draftProposalsForVisitPlan(req.userId!, req.params.id);
  if ("error" in out) {
    res.status(out.code === "NOT_FOUND" ? 404 : out.code === "DB_ERROR" ? 500 : 400).json({
      error: out.error,
      code: out.code,
    });
    return;
  }
  res.json(out);
});

visitsRouter.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { error } = await supabaseAdmin
    .from("visit_plans")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.userId!);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ deleted: true });
});

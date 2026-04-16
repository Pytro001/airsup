import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { planVisits } from "../agents/visit-planner.js";

export const visitsRouter = Router();

visitsRouter.post("/plan", requireAuth, async (req: AuthRequest, res: Response) => {
  const { factory_ids, start_date } = req.body as { factory_ids: number[]; start_date: string };

  if (!factory_ids?.length || !start_date) {
    res.status(400).json({ error: "factory_ids (array) and start_date required" });
    return;
  }

  try {
    const result = await planVisits(req.userId!, factory_ids, start_date);
    res.json(result);
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
      visit_stops(id, factory_id, scheduled_time, status, notes, factories(name, location))
    `)
    .eq("user_id", req.userId!)
    .order("travel_date", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ plans: data || [] });
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

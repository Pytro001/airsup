import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";

export const matchesRouter = Router();

matchesRouter.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("matches")
    .select(`
      id, status, quote, context_summary, wa_group_id, created_at,
      projects!inner(id, title, user_id),
      factories(id, name, location, category)
    `)
    .eq("projects.user_id", req.userId!)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ matches: data || [] });
});

matchesRouter.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("matches")
    .select(`
      id, status, quote, context_summary, wa_group_id, created_at,
      projects!inner(id, title, description, user_id),
      factories(id, name, location, category, capabilities),
      timelines(id, milestone, due_date, status),
      payments(id, amount_cents, currency, status)
    `)
    .eq("id", req.params.id)
    .eq("projects.user_id", req.userId!)
    .single();

  if (error) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  res.json({ match: data });
});

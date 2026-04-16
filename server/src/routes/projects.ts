import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";

export const projectsRouter = Router();

projectsRouter.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select(`
      id, title, description, status, requirements, ai_summary, created_at,
      companies(name),
      matches(id, status, quote, factories(name, location))
    `)
    .eq("user_id", req.userId!)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ projects: data || [] });
});

projectsRouter.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select(`
      id, title, description, status, requirements, ai_summary, created_at,
      companies(name),
      matches(id, status, quote, context_summary, factories(name, location, category)),
      factory_searches(id, status, search_criteria, created_at)
    `)
    .eq("id", req.params.id)
    .eq("user_id", req.userId!)
    .single();

  if (error) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ project: data });
});

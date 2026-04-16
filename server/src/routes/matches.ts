import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { listFilesForProjectWithUrls } from "../lib/project-files.js";

export const matchesRouter = Router();

/** Buyer or matched supplier: signed URLs for project files. */
matchesRouter.get("/:id/files", requireAuth, async (req: AuthRequest, res: Response) => {
  const matchId = req.params.id;

  const { data: match, error } = await supabaseAdmin
    .from("matches")
    .select("id, project_id, projects!inner(user_id), factories!inner(user_id)")
    .eq("id", matchId)
    .single();

  if (error || !match) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  const proj = (Array.isArray(match.projects) ? match.projects[0] : match.projects) as { user_id: string };
  const fac = (Array.isArray(match.factories) ? match.factories[0] : match.factories) as { user_id: string | null };
  const uid = req.userId!;

  const isBuyer = proj.user_id === uid;
  const isSupplier = fac.user_id != null && fac.user_id === uid;

  if (!isBuyer && !isSupplier) {
    res.status(403).json({ error: "Not allowed" });
    return;
  }

  const projectId = match.project_id as string;
  const files = await listFilesForProjectWithUrls(projectId);
  res.json({ files });
});

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

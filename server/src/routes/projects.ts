import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { listFilesForProjectWithUrls, registerProjectFileRecord } from "../lib/project-files.js";

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

projectsRouter.get("/latest", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("id, title, status")
    .eq("user_id", req.userId!)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ project: data });
});

projectsRouter.get("/:id/files", requireAuth, async (req: AuthRequest, res: Response) => {
  const projectId = req.params.id;
  const { data: project, error: pe } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", req.userId!)
    .maybeSingle();

  if (pe || !project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const files = await listFilesForProjectWithUrls(projectId);
  res.json({ files });
});

/** Register file after direct Storage upload (same as chat/register-file, project id from URL). */
projectsRouter.post("/:id/register-file", requireAuth, async (req: AuthRequest, res: Response) => {
  const projectId = req.params.id;
  const userId = req.userId!;
  const body = req.body as {
    storage_path?: string;
    filename?: string;
    bytes?: number;
    mime_type?: string;
  };

  if (!body.storage_path?.trim() || !body.filename?.trim()) {
    res.status(400).json({ error: "storage_path and filename are required" });
    return;
  }

  const { data: project, error: pe } = await supabaseAdmin
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  if (pe || !project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const result = await registerProjectFileRecord({
    userId,
    storage_path: body.storage_path.trim(),
    filename: body.filename.trim(),
    bytes: typeof body.bytes === "number" ? body.bytes : 0,
    mime_type: typeof body.mime_type === "string" ? body.mime_type : "",
    source: "manual",
    project_id: projectId,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json({
    id: result.id,
    filename: body.filename.trim(),
    signed_url: result.signed_url,
  });
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

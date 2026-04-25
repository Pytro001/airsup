import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { listFilesForProjectWithUrls, registerProjectFileRecord } from "../lib/project-files.js";
import { mergeSearchCriteriaFromSources } from "../lib/search-criteria.js";
import { runJobPollOnce } from "../jobs/poll.js";

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

/**
 * Create a project with no LLM import — for onboarding with only non-text files (e.g. 3D, images).
 * Same factory search kickoff as intake import.
 */
projectsRouter.post("/bootstrap", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const { data: company } = await supabaseAdmin.from("companies").select("id").eq("user_id", userId).maybeSingle();
  if (!company?.id) {
    res.status(400).json({ error: "Complete company step first, then try again." });
    return;
  }
  const companyId = company.id;

  const { data: companyRow } = await supabaseAdmin
    .from("companies")
    .select("name, description, industry, location, ai_knowledge")
    .eq("id", companyId)
    .maybeSingle();

  const coName = (companyRow?.name && String(companyRow.name).trim()) || "";
  const title = coName ? `Project — ${coName.slice(0, 80)}` : "New project";
  const description =
    "Your reference files are attached. Open chat to add details and refine the factory search.";

  const { data: projectRow, error: pe } = await supabaseAdmin
    .from("projects")
    .insert({
      user_id: userId,
      company_id: companyId,
      title,
      description,
      requirements: {},
      ai_summary: { readiness: "low" as const },
      status: "intake",
      brief_source_type: "file",
      brief_source_url: null,
      brief_raw: null,
    })
    .select("id, title, description, requirements, ai_summary")
    .single();

  if (pe || !projectRow) {
    console.error("[projects] bootstrap insert:", pe);
    res.status(500).json({ error: pe?.message || "Could not create project" });
    return;
  }

  const project = projectRow as {
    id: string;
    title: string;
    description: string;
    requirements: Record<string, unknown> | null;
    ai_summary: Record<string, unknown> | null;
  };

  const merged = mergeSearchCriteriaFromSources(undefined, project, companyRow);

  const { data: search, error: se } = await supabaseAdmin
    .from("factory_searches")
    .insert({ project_id: project.id, search_criteria: merged, status: "pending" })
    .select("id")
    .single();

  if (se || !search) {
    console.error("[projects] bootstrap factory_searches insert:", se);
    res.status(500).json({ error: se?.message || "Project created but search could not start" });
    return;
  }

  await supabaseAdmin.from("projects").update({ status: "searching" }).eq("id", project.id);

  const kick = process.env.RUN_JOB_POLL_AFTER_SEARCH === "1" || (process.env.NODE_ENV !== "production" && !process.env.VERCEL);
  if (kick) {
    void runJobPollOnce().catch((err) => console.error("[Airsup] post-bootstrap job poll:", err));
  }

  res.json({ projectId: project.id, title: project.title, requirements: project.requirements });
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
      brief_source_type, brief_source_url, brief_raw,
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

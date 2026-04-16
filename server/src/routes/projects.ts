import { Router } from "express";
import type { Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { listFilesForProjectWithUrls, safeFileSegment, signFileUrl } from "../lib/project-files.js";

export const projectsRouter = Router();

const BUCKET = "project-files";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 15 },
});

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

projectsRouter.post(
  "/:id/files",
  requireAuth,
  upload.array("files", 15) as unknown as import("express").RequestHandler,
  async (req: AuthRequest, res: Response) => {
  const projectId = req.params.id;
  const userId = req.userId!;

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

  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) {
    res.status(400).json({ error: "No files uploaded" });
    return;
  }

  const created: Array<{ id: string; filename: string; project_id: string; signed_url: string | null }> = [];

  for (const file of files) {
    const id = randomUUID();
    const safeName = safeFileSegment(file.originalname || "file");
    const storagePath = `${userId}/${projectId}/${id}_${safeName}`;

    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, file.buffer, {
      contentType: file.mimetype || "application/octet-stream",
      upsert: false,
    });

    if (upErr) {
      console.error("[Airsup] storage upload:", upErr.message);
      res.status(500).json({ error: "Upload failed: " + upErr.message });
      return;
    }

    const { data: row, error: insErr } = await supabaseAdmin
      .from("project_files")
      .insert({
        user_id: userId,
        project_id: projectId,
        storage_path: storagePath,
        filename: file.originalname || safeName,
        mime_type: file.mimetype || "",
        bytes: file.size,
        source: "manual",
      })
      .select("id")
      .single();

    if (insErr || !row) {
      console.error("[Airsup] project_files insert:", insErr?.message);
      res.status(500).json({ error: "Could not save file metadata" });
      return;
    }

    const signed_url = await signFileUrl(storagePath);
    created.push({
      id: row.id,
      filename: file.originalname || safeName,
      project_id: projectId,
      signed_url,
    });
  }

  res.json({ files: created });
  }
);

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

import { Router } from "express";
import type { Response } from "express";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { runIntakeAgent, loadContext, INIT_SYSTEM_INSTRUCTION } from "../agents/intake.js";
import { safeFileSegment, signFileUrl } from "../lib/project-files.js";

export const chatRouter = Router();

const BUCKET = "project-files";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 15 },
});

/** Multipart file upload from buyer chat; ties to project or orphan row. */
chatRouter.post(
  "/upload-files",
  requireAuth,
  upload.array("files", 15) as unknown as import("express").RequestHandler,
  async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) {
    res.status(400).json({ error: "No files uploaded" });
    return;
  }

  let projectId = String((req.body as { project_id?: string })?.project_id || "").trim();
  if (!projectId) {
    const { data: latest } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    projectId = latest?.id || "";
  } else {
    const { data: ok } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!ok) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
  }

  const created: Array<{ id: string; filename: string; project_id: string | null; signed_url: string | null }> = [];

  for (const file of files) {
    const id = randomUUID();
    const safeName = safeFileSegment(file.originalname || "file");
    const storagePath = projectId
      ? `${userId}/${projectId}/${id}_${safeName}`
      : `${userId}/orphan/${id}_${safeName}`;

    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(storagePath, file.buffer, {
      contentType: file.mimetype || "application/octet-stream",
      upsert: false,
    });

    if (upErr) {
      console.error("[Airsup] chat storage upload:", upErr.message);
      res.status(500).json({ error: "Upload failed: " + upErr.message });
      return;
    }

    const { data: row, error: insErr } = await supabaseAdmin
      .from("project_files")
      .insert({
        user_id: userId,
        project_id: projectId || null,
        storage_path: storagePath,
        filename: file.originalname || safeName,
        mime_type: file.mimetype || "",
        bytes: file.size,
        source: "chat",
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
      project_id: projectId || null,
      signed_url,
    });
  }

  res.json({ files: created });
  }
);

chatRouter.post("/init", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  try {
    const { data: existing } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .is("project_id", null)
      .limit(1);

    if (existing && existing.length > 0) {
      res.json({ already_initialized: true });
      return;
    }

    const { reply, options, action } = await runIntakeAgent(
      userId,
      "Hello, I just signed up.",
      [],
      INIT_SYSTEM_INSTRUCTION
    );

    await supabaseAdmin.from("conversations").insert({
      user_id: userId,
      project_id: null,
      role: "assistant",
      content: reply,
      metadata: { options: options || null, action: action || null },
    });

    res.json({ reply, options: options || null, action: action || null });
  } catch (err) {
    console.error("[Airsup] chat init error:", err);
    res.status(500).json({ error: "Failed to initialize chat." });
  }
});

chatRouter.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const { message, project_id } = req.body as { message?: string; project_id?: string };

  if (!message?.trim()) {
    res.status(400).json({ error: "Message is required" });
    return;
  }

  try {
    let historyQuery = supabaseAdmin.from("conversations").select("role, content").eq("user_id", userId);
    if (project_id) {
      historyQuery = historyQuery.eq("project_id", project_id);
    } else {
      historyQuery = historyQuery.is("project_id", null);
    }
    const { data: history } = await historyQuery.order("created_at", { ascending: true }).limit(50);

    const conversationHistory: MessageParam[] = (history || []).map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
    }));

    await supabaseAdmin.from("conversations").insert({
      user_id: userId,
      project_id: project_id || null,
      role: "user",
      content: message.trim(),
    });

    const { reply, options, action } = await runIntakeAgent(userId, message.trim(), conversationHistory);

    const metadata: Record<string, unknown> = {};
    if (options) metadata.options = options;
    if (action) metadata.action = action;

    await supabaseAdmin.from("conversations").insert({
      user_id: userId,
      project_id: project_id || null,
      role: "assistant",
      content: reply,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });

    res.json({ reply, options: options || null, action: action || null });
  } catch (err) {
    console.error("[Airsup] chat error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

chatRouter.post("/ask", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const { match_id, question } = req.body as { match_id?: string; question?: string };

  if (!match_id || !question?.trim()) {
    res.status(400).json({ error: "match_id and question are required." });
    return;
  }

  try {
    const { data: match } = await supabaseAdmin
      .from("matches")
      .select("id, project_id, factory_id")
      .eq("id", match_id)
      .single();

    if (!match) { res.status(404).json({ error: "Match not found." }); return; }

    const { data: factory } = await supabaseAdmin
      .from("factories")
      .select("user_id")
      .eq("id", match.factory_id)
      .single();

    if (factory?.user_id !== userId) {
      res.status(403).json({ error: "Only the matched supplier can ask questions about a buyer." });
      return;
    }

    const { data: project } = await supabaseAdmin
      .from("projects")
      .select("title, description, requirements, ai_summary, user_id")
      .eq("id", match.project_id)
      .single();

    if (!project) { res.status(404).json({ error: "Project not found." }); return; }

    const context = await loadContext(project.user_id);

    const { getAnthropicClient } = await import("../services/anthropic.js");
    const anthropic = getAnthropicClient();

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      system: `You are helping a factory engineer understand a buyer's project. Here is everything known about the buyer and their requirements. Answer the engineer's questions accurately and concisely based on this context. If the answer isn't in the context, say so honestly.${context}`,
      messages: [{ role: "user", content: question.trim() }],
    });

    const text = response.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("\n\n");
    res.json({ reply: text });
  } catch (err) {
    console.error("[Airsup] supplier ask error:", err);
    res.status(500).json({ error: "Failed to process question." });
  }
});

chatRouter.get("/history", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const projectId = req.query.project_id as string | undefined;

  try {
    let q = supabaseAdmin.from("conversations").select("id, role, content, metadata, created_at").eq("user_id", userId);
    if (projectId) {
      q = q.eq("project_id", projectId);
    } else {
      q = q.is("project_id", null);
    }

    const { data, error } = await q.order("created_at", { ascending: true }).limit(100);
    if (error) {
      console.error(
        "[Airsup] GET /history supabase error:",
        JSON.stringify({
          code: (error as { code?: string }).code,
          message: error.message,
          details: (error as { details?: string }).details,
          hint: (error as { hint?: string }).hint,
        })
      );
      const parts = [error.message, (error as { hint?: string }).hint, (error as { details?: string }).details].filter(Boolean);
      res.status(500).json({ error: parts.join(" | ") || "Database error", code: (error as { code?: string }).code });
      return;
    }
    res.json({ messages: data || [] });
  } catch (e) {
    console.error("[Airsup] GET /history handler throw:", e);
    res.status(500).json({ error: `Unexpected: ${String(e)}` });
  }
});

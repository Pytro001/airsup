import { Router } from "express";
import type { Response } from "express";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { runIntakeAgent } from "../agents/intake.js";

export const chatRouter = Router();

chatRouter.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const { message, project_id } = req.body as { message?: string; project_id?: string };

  if (!message?.trim()) {
    res.status(400).json({ error: "Message is required" });
    return;
  }

  try {
    let historyQuery = supabaseAdmin
      .from("conversations")
      .select("role, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(50);
    if (project_id) {
      historyQuery = historyQuery.eq("project_id", project_id);
    } else {
      historyQuery = historyQuery.is("project_id", null);
    }
    const { data: history } = await historyQuery;

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

    const { reply } = await runIntakeAgent(userId, message.trim(), conversationHistory);

    await supabaseAdmin.from("conversations").insert({
      user_id: userId,
      project_id: project_id || null,
      role: "assistant",
      content: reply,
    });

    res.json({ reply });
  } catch (err) {
    console.error("[Airsup] chat error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

chatRouter.get("/history", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const projectId = req.query.project_id as string | undefined;

  const query = supabaseAdmin
    .from("conversations")
    .select("id, role, content, metadata, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(100);

  if (projectId) {
    query.eq("project_id", projectId);
  } else {
    query.is("project_id", null);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ messages: data || [] });
});

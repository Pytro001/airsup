import { Router } from "express";
import type { Response } from "express";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { runIntakeAgent, loadContext, INIT_SYSTEM_INSTRUCTION } from "../agents/intake.js";

export const chatRouter = Router();

// #region agent log
function debugLog(location: string, message: string, data: Record<string, unknown>, hypothesisId: string): void {
  fetch("http://127.0.0.1:7803/ingest/440abadd-e42c-4ad6-b3c7-7a5e0395097a", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a202bb" },
    body: JSON.stringify({ sessionId: "a202bb", location, message, data, timestamp: Date.now(), hypothesisId }),
  }).catch(() => {});
}
// #endregion

chatRouter.post("/init", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  try {
    debugLog("chat.ts:POST/init", "enter", { userIdLen: userId.length }, "H5");
    const { data: existing } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .is("project_id", null)
      .limit(1);

    if (existing && existing.length > 0) {
      debugLog("chat.ts:POST/init", "already_initialized", { count: existing.length }, "H3");
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

    debugLog("chat.ts:POST/init", "success", { replyLen: reply?.length ?? 0, hasOptions: !!options?.length }, "H5");
    res.json({ reply, options: options || null, action: action || null });
  } catch (err) {
    console.error("[Airsup] chat init error:", err);
    debugLog("chat.ts:POST/init", "catch", { err: String(err) }, "H5");
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
  debugLog("chat.ts:GET/history", "enter", { hasProjectId: !!projectId }, "H1");

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
    debugLog("chat.ts:GET/history", "query_error", { err: error.message }, "H1");
    res.status(500).json({ error: error.message });
    return;
  }
  debugLog("chat.ts:GET/history", "ok", { count: (data || []).length }, "H2");
  res.json({ messages: data || [] });
});

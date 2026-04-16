import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";

export const connectionChatRouter = Router();

connectionChatRouter.get("/:matchId/messages", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const { matchId } = req.params;

  const hasAccess = await checkMatchAccess(userId, matchId);
  if (!hasAccess) {
    res.status(403).json({ error: "You don't have access to this connection." });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("connection_messages")
    .select("id, sender_id, content, created_at")
    .eq("match_id", matchId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ messages: data || [] });
});

connectionChatRouter.post("/:matchId/messages", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const { matchId } = req.params;
  const { content } = req.body as { content?: string };

  if (!content?.trim()) {
    res.status(400).json({ error: "Message content is required." });
    return;
  }

  const hasAccess = await checkMatchAccess(userId, matchId);
  if (!hasAccess) {
    res.status(403).json({ error: "You don't have access to this connection." });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("connection_messages")
    .insert({ match_id: matchId, sender_id: userId, content: content.trim() })
    .select("id, sender_id, content, created_at")
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ message: data });
});

async function checkMatchAccess(userId: string, matchId: string): Promise<boolean> {
  const { data: match } = await supabaseAdmin
    .from("matches")
    .select("id, project_id, factory_id")
    .eq("id", matchId)
    .single();

  if (!match) return false;

  const { data: project } = await supabaseAdmin
    .from("projects")
    .select("user_id")
    .eq("id", match.project_id)
    .single();

  if (project?.user_id === userId) return true;

  const { data: factory } = await supabaseAdmin
    .from("factories")
    .select("user_id")
    .eq("id", match.factory_id)
    .single();

  if (factory?.user_id === userId) return true;

  return false;
}

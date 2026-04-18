import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";

export const outreachRouter = Router();

type PendingMatchPayload = {
  project_id: string;
  factory_id: number;
  quote: Record<string, unknown>;
  context_summary: Record<string, unknown>;
};

outreachRouter.post("/:id/accept", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const outreachId = req.params.id;

  const { data: row, error } = await supabaseAdmin
    .from("outreach_logs")
    .select("id, stage, pending_match, factory_id")
    .eq("id", outreachId)
    .maybeSingle();

  if (error || !row) {
    res.status(404).json({ error: "Outreach not found" });
    return;
  }

  const { data: factory } = await supabaseAdmin
    .from("factories")
    .select("user_id")
    .eq("id", row.factory_id)
    .maybeSingle();

  if (!factory || factory.user_id !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  if (row.stage !== "await_supplier" || !row.pending_match) {
    res.status(400).json({ error: "This brief is not waiting for your response" });
    return;
  }

  const pm = row.pending_match as PendingMatchPayload;
  if (!pm.project_id || pm.factory_id == null) {
    res.status(500).json({ error: "Invalid pending match data" });
    return;
  }

  const { error: insErr } = await supabaseAdmin.from("matches").insert({
    project_id: pm.project_id,
    factory_id: pm.factory_id,
    quote: pm.quote || {},
    status: "pending",
    context_summary: pm.context_summary || {},
  });

  if (insErr) {
    console.error("[outreach/accept] insert match:", insErr);
    res.status(500).json({ error: insErr.message || "Could not create match" });
    return;
  }

  await supabaseAdmin
    .from("outreach_logs")
    .update({
      stage: "accepted",
      pending_match: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", outreachId);

  await supabaseAdmin
    .from("projects")
    .update({ status: "matched", updated_at: new Date().toISOString() })
    .eq("id", pm.project_id);

  res.json({ ok: true });
});

outreachRouter.post("/:id/decline", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const outreachId = req.params.id;

  const { data: row, error } = await supabaseAdmin
    .from("outreach_logs")
    .select("id, stage, factory_id")
    .eq("id", outreachId)
    .maybeSingle();

  if (error || !row) {
    res.status(404).json({ error: "Outreach not found" });
    return;
  }

  const { data: factory } = await supabaseAdmin
    .from("factories")
    .select("user_id")
    .eq("id", row.factory_id)
    .maybeSingle();

  if (!factory || factory.user_id !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const allowed = ["briefed", "negotiating", "await_supplier", "quoted"];
  if (!allowed.includes(row.stage)) {
    res.status(400).json({ error: "Cannot decline this brief in its current state" });
    return;
  }

  await supabaseAdmin
    .from("outreach_logs")
    .update({
      stage: "rejected",
      pending_match: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", outreachId);

  res.json({ ok: true });
});

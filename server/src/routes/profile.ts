import { Router } from "express";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../services/supabase.js";

export const profileRouter = Router();

async function resolveUserId(req: Request): Promise<string | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

/**
 * DELETE /api/profile/me
 * Soft-deletes the current user's profile (moves to admin bin).
 */
profileRouter.delete("/me", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", userId);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

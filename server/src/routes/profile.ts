import { Router } from "express";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../services/supabase.js";
import { isMissingDeletedAtColumnError, SOFT_DELETE_MIGRATION_HINT } from "../lib/soft-delete-errors.js";

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

  if (error) {
    if (isMissingDeletedAtColumnError(error)) {
      res.status(503).json({ error: error.message, code: "MISSING_DELETED_AT_COLUMN", hint: SOFT_DELETE_MIGRATION_HINT });
      return;
    }
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ ok: true });
});

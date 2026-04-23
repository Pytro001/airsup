import { Router } from "express";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../services/supabase.js";

export const factoriesRouter = Router();

/** Resolve the authenticated user from the Bearer token in the request. */
async function resolveUserId(req: Request): Promise<string | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

/**
 * GET /api/factories/me
 * Returns the factory profile for the authenticated supplier.
 */
factoriesRouter.get("/me", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { data, error } = await supabaseAdmin
    .from("factories")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ factory: data });
});

/**
 * PUT /api/factories/me
 * Upserts the factory profile for the authenticated supplier.
 * Uses service role to bypass RLS — the user is authenticated via JWT.
 */
factoriesRouter.put("/me", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const body = req.body as Record<string, unknown>;
  const payload = {
    user_id: userId,
    name: String(body.name || "").trim(),
    location: String(body.location || "").trim(),
    category: String(body.category || "").trim(),
    capabilities: body.capabilities || {},
    contact_info: body.contact_info || {},
    active: body.active !== false,
  };

  if (!payload.name) { res.status(400).json({ error: "Factory name is required" }); return; }
  if (!payload.location) { res.status(400).json({ error: "Location is required" }); return; }

  const { data: existing } = await supabaseAdmin
    .from("factories")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  let result;
  if (existing?.id) {
    result = await supabaseAdmin
      .from("factories")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
  } else {
    result = await supabaseAdmin
      .from("factories")
      .insert(payload)
      .select("*")
      .single();
  }

  if (result.error) { res.status(500).json({ error: result.error.message }); return; }
  res.json({ factory: result.data });
});

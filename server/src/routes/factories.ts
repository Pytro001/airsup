import { Router } from "express";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../services/supabase.js";

export const factoriesRouter = Router();

type ContactEntry = { name?: string; whatsapp: string };

/** Normalize contact_info to `{ contacts: [{ name?, whatsapp }] }` from new shape or legacy `name`/`phone`. */
export function normalizeContactInfo(raw: unknown): { contacts: ContactEntry[] } {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.contacts)) {
      const contacts: ContactEntry[] = [];
      for (const item of o.contacts) {
        if (!item || typeof item !== "object") continue;
        const c = item as Record<string, unknown>;
        const wa = String(c.whatsapp ?? "").trim();
        const name = c.name != null ? String(c.name).trim() : "";
        if (!wa) continue;
        contacts.push(name ? { name, whatsapp: wa } : { whatsapp: wa });
      }
      if (contacts.length) return { contacts };
    }
    const legacyPhone = String(o.phone ?? o.whatsapp ?? "").trim();
    const legacyName = String(o.name ?? "").trim();
    if (legacyPhone || legacyName) {
      return {
        contacts: [{ ...(legacyName ? { name: legacyName } : {}), whatsapp: legacyPhone }],
      };
    }
  }
  return { contacts: [{ whatsapp: "" }] };
}

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
  if (data) {
    (data as { contact_info: unknown }).contact_info = normalizeContactInfo(data.contact_info);
  }
  res.json({ factory: data });
});

/**
 * PUT /api/factories/me
 * Upserts the factory profile for the authenticated supplier.
 * Uses service role to bypass RLS. The user is authenticated via JWT.
 */
factoriesRouter.put("/me", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const body = req.body as Record<string, unknown>;
  const normalized = normalizeContactInfo(body.contact_info);
  if (!normalized.contacts[0]?.whatsapp?.trim()) {
    res.status(400).json({ error: "Primary WhatsApp is required in contact_info.contacts[0].whatsapp" });
    return;
  }

  const payload = {
    user_id: userId,
    name: String(body.name || "").trim(),
    location: String(body.location || "").trim(),
    category: String(body.category || "").trim(),
    capabilities: body.capabilities || {},
    contact_info: normalized,
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
  const row = result.data as Record<string, unknown> | null;
  if (row) row.contact_info = normalizeContactInfo(row.contact_info);
  res.json({ factory: row });
});

/**
 * DELETE /api/factories/me
 * Soft-deletes the supplier's factory profile (moves it to the bin).
 */
factoriesRouter.delete("/me", async (req: Request, res: Response) => {
  const userId = await resolveUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { error } = await supabaseAdmin
    .from("factories")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

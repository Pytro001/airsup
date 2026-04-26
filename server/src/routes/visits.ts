import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { planVisits } from "../agents/visit-planner.js";
import { draftProposalsForVisitPlan, sendVisitProposalsToSuppliers } from "../agents/visit-negotiate.js";
import { buildAmapStaticMapUrl } from "../lib/amap.js";

export const visitsRouter = Router();

type PlanRow = Record<string, unknown> & { visit_stops?: Array<{ confirmation_status?: string }> | null };

function withMapUrl(plan: PlanRow): PlanRow {
  const route = plan.route as { stop_details?: Array<{ lat?: unknown; lng?: unknown }> } | null | undefined;
  const details = route?.stop_details;
  if (!Array.isArray(details) || !details.length) {
    return { ...plan, map_static_url: null as string | null };
  }
  const pts: Array<{ lng: number; lat: number }> = [];
  for (const d of details) {
    const lat = typeof d.lat === "number" ? d.lat : null;
    const lng = typeof d.lng === "number" ? d.lng : null;
    if (lat != null && lng != null) {
      pts.push({ lng, lat });
    }
  }
  return { ...plan, map_static_url: buildAmapStaticMapUrl(pts) };
}

function isPlanCalendarConfirmed(visitStops: Array<{ confirmation_status?: string }> | null | undefined): boolean {
  if (!visitStops || !visitStops.length) return false;
  return visitStops.every((s) => s.confirmation_status === "confirmed");
}

function isPlanPending(visitStops: Array<{ confirmation_status?: string }> | null | undefined): boolean {
  if (!visitStops || !visitStops.length) return true;
  return visitStops.some((s) => s.confirmation_status !== "confirmed");
}

visitsRouter.post("/plan", requireAuth, async (req: AuthRequest, res: Response) => {
  const body = req.body as {
    factory_ids?: number[];
    match_ids?: string[];
    start_date?: string;
  };
  const { factory_ids, match_ids, start_date } = body;

  if (!start_date || (!factory_ids?.length && !match_ids?.length)) {
    res.status(400).json({
      error: "start_date and either match_ids (preferred) or factory_ids are required",
      code: "INPUT_REQUIRED",
    });
    return;
  }

  try {
    const result = await planVisits(req.userId!, {
      startDate: start_date,
      matchIds: match_ids,
      factoryIds: factory_ids,
    });
    if (result._error) {
      const code = result._error.code;
      const status =
        code === "DB_ERROR" ? 500 : code === "SCHEDULE_OVERFLOW" || code === "SCHEDULE_CONFLICT" ? 400 : 400;
      res.status(status).json({
        error: result._error.message,
        code: result._error.code,
        warnings: result.warnings,
      });
      return;
    }
    const { _error, ...out } = result;
    res.json(out);
  } catch (err) {
    console.error("[Visits] plan error:", err);
    res.status(500).json({ error: "Visit planning failed" });
  }
});

visitsRouter.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from("visit_plans")
    .select(
      `id, travel_date, region, route, created_at, route_feedback, route_feedback_at,
      visit_stops(
        id, factory_id, match_id, scheduled_time, status, notes,
        confirmation_status, supplier_proposed_time, supplier_counter_message,
        factories(name, location)
      )`
    )
    .eq("user_id", req.userId!)
    .order("travel_date", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  const all = (data || []).map((plan) => withMapUrl(plan as PlanRow)) as Array<PlanRow & { visit_stops?: Array<{ confirmation_status?: string }> }>;
  const confirmed_plans: typeof all = [];
  const pending_plans: typeof all = [];
  for (const p of all) {
    if (isPlanCalendarConfirmed(p.visit_stops)) {
      confirmed_plans.push(p);
    }
    if (isPlanPending(p.visit_stops)) {
      pending_plans.push(p);
    }
  }
  res.json({ confirmed_plans, pending_plans });
});

/** Factory owner: pending or counter-proposed visit stops for their factories. */
visitsRouter.get("/supplier/pending", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const { data: factories, error: fErr } = await supabaseAdmin
    .from("factories")
    .select("id")
    .eq("user_id", userId);
  if (fErr) {
    res.status(500).json({ error: fErr.message });
    return;
  }
  const fids = (factories || []).map((f) => f.id);
  if (!fids.length) {
    res.json({ items: [] });
    return;
  }
  const { data: rows, error } = await supabaseAdmin
    .from("visit_stops")
    .select(
      `id, plan_id, factory_id, match_id, scheduled_time, confirmation_status, supplier_proposed_time, supplier_counter_message,
      visit_plans(travel_date, region, route, user_id, route_feedback),
      matches(status, projects(title)),
      factories(name, location)`
    )
    .in("factory_id", fids)
    .in("confirmation_status", ["pending_supplier", "counter_proposed"])
    .order("id", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ items: rows || [] });
});

visitsRouter.post("/stops/:stopId/supplier-accept", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const stopId = req.params.stopId;
  const { data: stop, error } = await supabaseAdmin
    .from("visit_stops")
    .select(
      "id, factory_id, confirmation_status, scheduled_time, plan_id, factories!inner(id, user_id)"
    )
    .eq("id", stopId)
    .maybeSingle();
  if (error || !stop) {
    res.status(404).json({ error: "Stop not found" });
    return;
  }
  const f = (stop as { factories: { user_id: string } | { user_id: string }[] }).factories;
  const owner = Array.isArray(f) ? f[0] : f;
  if (owner.user_id !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (stop.confirmation_status !== "pending_supplier") {
    res.status(400).json({ error: "This visit is not waiting for your confirmation." });
    return;
  }
  const { error: uerr } = await supabaseAdmin
    .from("visit_stops")
    .update({
      confirmation_status: "confirmed",
      supplier_proposed_time: null,
      supplier_counter_message: null,
    })
    .eq("id", stopId);
  if (uerr) {
    res.status(500).json({ error: uerr.message });
    return;
  }
  res.json({ ok: true });
});

visitsRouter.post("/stops/:stopId/supplier-counter", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const stopId = req.params.stopId;
  const { proposed_time, message } = req.body as { proposed_time?: string; message?: string };
  const { data: stop, error } = await supabaseAdmin
    .from("visit_stops")
    .select("id, factory_id, match_id, plan_id, confirmation_status, factories!inner(user_id)")
    .eq("id", stopId)
    .maybeSingle();
  if (error || !stop) {
    res.status(404).json({ error: "Stop not found" });
    return;
  }
  const f = (stop as { factories: { user_id: string } | { user_id: string }[] }).factories;
  const owner = Array.isArray(f) ? f[0] : f;
  if (owner.user_id !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (stop.confirmation_status !== "pending_supplier") {
    res.status(400).json({ error: "You can only suggest another time for visits awaiting your response." });
    return;
  }
  const t = (proposed_time && String(proposed_time).trim()) || "";
  if (!t) {
    res.status(400).json({ error: "proposed_time is required (e.g. 14:30 or a short note of when works)." });
    return;
  }
  const { error: uerr } = await supabaseAdmin
    .from("visit_stops")
    .update({
      confirmation_status: "counter_proposed",
      supplier_proposed_time: t,
      supplier_counter_message: message ? String(message).trim().slice(0, 2000) : null,
    })
    .eq("id", stopId);
  if (uerr) {
    res.status(500).json({ error: uerr.message });
    return;
  }
  if (stop.match_id && (message || t)) {
    const note = (message && String(message).trim()) || `Alternative time: ${t}`;
    const line = `[Visit — alternative time] ${note}`;
    await supabaseAdmin.from("connection_messages").insert({
      match_id: stop.match_id,
      sender_id: userId,
      content: line.slice(0, 8000),
    });
  }
  res.json({ ok: true });
});

visitsRouter.post("/stops/:stopId/buyer-confirm-counter", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const stopId = req.params.stopId;
  const { data: stop, error } = await supabaseAdmin
    .from("visit_stops")
    .select(
      "id, plan_id, confirmation_status, scheduled_time, supplier_proposed_time, visit_plans!inner(user_id)"
    )
    .eq("id", stopId)
    .maybeSingle();
  if (error || !stop) {
    res.status(404).json({ error: "Stop not found" });
    return;
  }
  const plan = (stop as { visit_plans: { user_id: string } | { user_id: string }[] }).visit_plans;
  const pu = Array.isArray(plan) ? plan[0] : plan;
  if (pu.user_id !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (stop.confirmation_status !== "counter_proposed") {
    res.status(400).json({ error: "This stop is not waiting for you to accept a counter-proposal." });
    return;
  }
  const raw = (stop.supplier_proposed_time as string | null) || stop.scheduled_time;
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    res.status(400).json({ error: "No proposed time to confirm." });
    return;
  }
  const { error: uerr } = await supabaseAdmin
    .from("visit_stops")
    .update({
      confirmation_status: "confirmed",
      scheduled_time: raw.trim().slice(0, 32),
      supplier_proposed_time: null,
      supplier_counter_message: null,
    })
    .eq("id", stopId);
  if (uerr) {
    res.status(500).json({ error: uerr.message });
    return;
  }
  res.json({ ok: true });
});

visitsRouter.patch("/:id/route-feedback", requireAuth, async (req: AuthRequest, res: Response) => {
  const { feedback } = req.body as { feedback?: string };
  const text = feedback != null ? String(feedback) : "";
  const { data, error } = await supabaseAdmin
    .from("visit_plans")
    .update({
      route_feedback: text,
      route_feedback_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .eq("user_id", req.userId!)
    .select("id")
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }
  res.json({ saved: true });
});

visitsRouter.post("/:id/submit-confirmation", requireAuth, async (req: AuthRequest, res: Response) => {
  const out = await sendVisitProposalsToSuppliers(req.userId!, req.params.id);
  if ("error" in out) {
    const code = out.code;
    const status =
      code === "NOT_FOUND" ? 404
      : code === "DB_ERROR" ? 500
      : 400;
    res.status(status).json({ error: out.error, code: out.code });
    return;
  }
  res.json({ ok: true, sent: out.sent });
});

/**
 * Bilingual message drafts for each stop on a plan (Phase 2). Buyer pastes or sends via connection chat.
 */
visitsRouter.post("/:id/propose-messages", requireAuth, async (req: AuthRequest, res: Response) => {
  const out = await draftProposalsForVisitPlan(req.userId!, req.params.id);
  if ("error" in out) {
    res.status(out.code === "NOT_FOUND" ? 404 : out.code === "DB_ERROR" ? 500 : 400).json({
      error: out.error,
      code: out.code,
    });
    return;
  }
  res.json(out);
});

visitsRouter.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const { error } = await supabaseAdmin
    .from("visit_plans")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.userId!);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ deleted: true });
});

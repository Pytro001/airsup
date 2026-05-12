import { Router } from "express";
import { supabaseAdmin } from "../services/supabase.js";
import { runColdDiscovery } from "../agents/cold-discovery.js";
import { runColdQuality } from "../agents/cold-quality.js";
import { runColdOutreach } from "../agents/cold-outreach.js";
import { runColdReply, reconcileConversions } from "../agents/cold-reply.js";
import { runColdAdminTask } from "../agents/cold-admin.js";

export const coldRouter = Router();

/**
 * Public unsubscribe endpoint. Token is in the email footer.
 * GET /api/cold/unsubscribe/:token — also supports POST (List-Unsubscribe one-click).
 */
async function handleUnsub(token: string) {
  await supabaseAdmin
    .from("cold_targets")
    .update({ status: "unsubscribed", last_event_at: new Date().toISOString() })
    .eq("unsub_token", token);
}

coldRouter.get("/unsubscribe/:token", async (req, res) => {
  await handleUnsub(req.params.token);
  res.send(
    `<!doctype html><html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px">` +
    `<div><h1 style="font-weight:500">You're unsubscribed</h1><p>You won't hear from us again.</p></div></body></html>`
  );
});
coldRouter.post("/unsubscribe/:token", async (req, res) => {
  await handleUnsub(req.params.token);
  res.status(200).json({ ok: true });
});

/**
 * Admin-only manual triggers. Gate behind ADMIN_TOKEN.
 */
function requireAdmin(req: { headers: Record<string, unknown> }, res: { status: (n: number) => { json: (o: unknown) => void } }): boolean {
  const t = process.env.ADMIN_TOKEN;
  const h = String(req.headers["x-admin-token"] || "");
  if (!t || h !== t) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

coldRouter.get("/stats", async (req, res) => {
  if (!requireAdmin(req as never, res as never)) return;
  const statuses = ["discovered", "qualified", "disqualified", "contacted", "replying", "converted", "unsubscribed"];
  const out: Record<string, number> = {};
  for (const s of statuses) {
    const { count } = await supabaseAdmin
      .from("cold_targets")
      .select("id", { count: "exact", head: true })
      .eq("status", s);
    out[s] = count || 0;
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await supabaseAdmin
    .from("cold_emails")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .gte("sent_at", today.toISOString());
  res.json({ targets: out, sent_today: sentToday || 0 });
});

/**
 * Admin one-shot: free-text instruction goes in, real factories get emailed.
 * Open like the rest of /api/admin/* (the admin page is unauth in this app).
 */
coldRouter.post("/admin-task", async (req, res) => {
  const instruction = String((req.body || {}).instruction || "").trim();
  if (!instruction || instruction.length < 10) {
    res.status(400).json({ error: "Provide a longer instruction." });
    return;
  }
  try {
    const result = await runColdAdminTask(instruction);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

coldRouter.post("/run/:job", async (req, res) => {
  if (!requireAdmin(req as never, res as never)) return;
  const job = req.params.job;
  try {
    if (job === "discovery") res.json({ inserted: await runColdDiscovery() });
    else if (job === "quality") res.json(await runColdQuality(20));
    else if (job === "outreach") res.json({ sent: await runColdOutreach(20) });
    else if (job === "reply") res.json({ processed: await runColdReply() });
    else if (job === "reconcile") res.json({ converted: await reconcileConversions() });
    else res.status(400).json({ error: "unknown job" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

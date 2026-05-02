import { Router } from "express";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../services/supabase.js";
import {
  isMissingDeletedAtColumnError,
  postgrestErrorText,
  SOFT_DELETE_MIGRATION_HINT,
} from "../lib/soft-delete-errors.js";
import { listFilesForProjectWithUrls } from "../lib/project-files.js";
import { runSourcingForProject, approveSourcingCandidate, rejectSourcingCandidate } from "../agents/sourcing.js";

export const adminRouter = Router();

type ProfileForAdmin = {
  id: string;
  display_name: string | null;
  company: string | null;
  headline: string | null;
  role: string | null;
  location: string | null;
  phone: string | null;
  created_at: string;
  deleted_at?: string | null;
};

type FactoryForAdmin = {
  id: number;
  user_id: string;
  name: string;
  location: string;
  category: string;
  capabilities: unknown;
  active: boolean;
  created_at: string;
  deleted_at?: string | null;
};

/** Row shape for admin overview project list (pipeline fields optional until migration 021). */
type AdminOverviewProject = {
  id: string;
  user_id: string;
  title: string | null;
  status: string | null;
  created_at: string;
  pipeline_step?: number | null;
  coordination_mode?: string | null;
};

/** Excludes soft-deleted rows; avoids .is("deleted_at", null) which can break if the column is missing. */
function filterNotDeleted<T extends { deleted_at?: string | null }>(rows: T[] | null): T[] {
  if (!rows) return [];
  return rows.filter((r) => r.deleted_at == null);
}

/**
 * Public (no auth) admin overview: customers on the left, factories on the right,
 * and the matches that connect them. Served by the static /admin page.
 * Excludes soft-deleted rows.
 */
adminRouter.get("/overview", async (_req, res: Response) => {
  try {
    const [companiesRes, projectsResFull, matchesRes, outreachRes] = await Promise.all([
      supabaseAdmin
        .from("companies")
        .select("id, user_id, name, description, industry, location, created_at")
        .limit(500),
      supabaseAdmin
        .from("projects")
        // Omit pipeline_step / coordination_mode: overview works without migration 021; details use select *.
        .select("id, user_id, title, status, created_at")
        .order("created_at", { ascending: false })
        .limit(1000),
      supabaseAdmin
        .from("matches")
        .select("id, status, quote, project_id, factory_id, created_at")
        .order("created_at", { ascending: false })
        .limit(1000),
      supabaseAdmin
        .from("outreach_logs")
        .select("id, stage, factory_id, search_id, created_at")
        .order("created_at", { ascending: false })
        .limit(1000),
    ]);
    {
      // #region agent log
      const pe = projectsResFull.error;
      void fetch("http://127.0.0.1:7803/ingest/440abadd-e42c-4ad6-b3c7-7a5e0395097a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ba8cdd" },
        body: JSON.stringify({
          sessionId: "ba8cdd",
          hypothesisId: "H1",
          location: "server/src/routes/admin.ts:overview:post-parallel",
          message: "admin overview projects query result",
          data: {
            hasProjectsError: !!pe,
            errText: pe ? postgrestErrorText(pe).slice(0, 500) : null,
            dataLen: Array.isArray(projectsResFull.data) ? projectsResFull.data.length : 0,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    }

    if (companiesRes.error) {
      console.error("[admin/overview] companies:", companiesRes.error);
      return res.status(500).json({ error: "companies: " + postgrestErrorText(companiesRes.error) });
    }
    if (projectsResFull.error) {
      console.error("[admin/overview] projects:", projectsResFull.error);
      return res.status(500).json({ error: "projects: " + postgrestErrorText(projectsResFull.error) });
    }
    const projects: AdminOverviewProject[] = (projectsResFull.data as AdminOverviewProject[]) || [];

    if (matchesRes.error) {
      console.error("[admin/overview] matches:", matchesRes.error);
      return res.status(500).json({ error: "matches: " + matchesRes.error.message });
    }
    if (outreachRes.error) {
      console.error("[admin/overview] outreach:", outreachRes.error);
      return res.status(500).json({ error: "outreach: " + outreachRes.error.message });
    }

    let profileRows: ProfileForAdmin[] = [];
    {
      const r1 = await supabaseAdmin
        .from("profiles")
        .select("id, display_name, company, headline, role, location, phone, created_at, deleted_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (r1.error) {
        const r2 = await supabaseAdmin
          .from("profiles")
          .select("id, display_name, company, headline, role, location, phone, created_at")
          .order("created_at", { ascending: false })
          .limit(500);
        if (r2.error) {
          console.error("[admin/overview] profiles:", r1.error, r2.error);
          return res.status(500).json({ error: "profiles: " + (r1.error.message || r2.error.message) });
        }
        profileRows = (r2.data as ProfileForAdmin[]) || [];
      } else {
        profileRows = filterNotDeleted((r1.data as ProfileForAdmin[]) || []);
      }
    }

    let factories: FactoryForAdmin[] = [];
    {
      const f1 = await supabaseAdmin
        .from("factories")
        .select("id, user_id, name, location, category, capabilities, active, created_at, deleted_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (f1.error) {
        const f2 = await supabaseAdmin
          .from("factories")
          .select("id, user_id, name, location, category, capabilities, active, created_at")
          .order("created_at", { ascending: false })
          .limit(500);
        if (f2.error) {
          console.error("[admin/overview] factories:", f1.error, f2.error);
          return res.status(500).json({ error: "factories: " + (f1.error.message || f2.error.message) });
        }
        factories = (f2.data as FactoryForAdmin[]) || [];
      } else {
        factories = filterNotDeleted((f1.data as FactoryForAdmin[]) || []);
      }
    }

    const profiles = profileRows;
    const companies = companiesRes.data || [];
    const matches = matchesRes.data || [];
    const outreach = outreachRes.data || [];

    const companyByUser = new Map<string, (typeof companies)[number]>();
    for (const c of companies) if (c.user_id) companyByUser.set(c.user_id, c);

    const projectsByUser = new Map<string, typeof projects>();
    const projectsById = new Map<string, (typeof projects)[number]>();
    for (const p of projects) {
      projectsById.set(p.id, p);
      const list = projectsByUser.get(p.user_id) || [];
      list.push(p);
      projectsByUser.set(p.user_id, list);
    }

    const matchesByProject = new Map<string, typeof matches>();
    const matchesByFactory = new Map<number, typeof matches>();
    for (const m of matches) {
      const pl = matchesByProject.get(m.project_id) || [];
      pl.push(m);
      matchesByProject.set(m.project_id, pl);
      const fl = matchesByFactory.get(m.factory_id) || [];
      fl.push(m);
      matchesByFactory.set(m.factory_id, fl);
    }

    const briefsByFactory = new Map<number, number>();
    for (const o of outreach) {
      briefsByFactory.set(o.factory_id, (briefsByFactory.get(o.factory_id) || 0) + 1);
    }

    /**
     * Suppliers: DB `role` = supplier and/or `headline` = supplier. Buyers use headline "startup" etc. with role "customer".
     */
    function isSupplierUserRecord(p: ProfileForAdmin) {
      if (p.role === "supplier") return true;
      if (String(p.headline || "").toLowerCase() === "supplier") return true;
      return false;
    }

    const factoryOwnerIds = new Set(factories.map((f) => f.user_id).filter(Boolean) as string[]);

    const customers = profiles
      .filter((p) => !isSupplierUserRecord(p) && !factoryOwnerIds.has(p.id))
      .map((p) => {
        const myProjects = projectsByUser.get(p.id) || [];
        const myMatches = myProjects.flatMap((pr) => matchesByProject.get(pr.id) || []);
        const connectedFactoryIds = Array.from(new Set(myMatches.map((m) => m.factory_id)));
        return {
          id: p.id,
          display_name: p.display_name || "",
          company: companyByUser.get(p.id)?.name || p.company || "",
          company_description: companyByUser.get(p.id)?.description || "",
          location: p.location || companyByUser.get(p.id)?.location || "",
          phone: p.phone || "",
          created_at: p.created_at,
          project_count: myProjects.length,
          project_titles: myProjects.map((pr) => pr.title).slice(0, 6),
          match_count: myMatches.length,
          connected_factory_ids: connectedFactoryIds,
          connected: myMatches.length > 0,
          projects: myProjects.map((pr) => ({
            id: pr.id,
            title: pr.title,
            status: pr.status,
            pipeline_step: typeof pr.pipeline_step === "number" ? pr.pipeline_step : 1,
          })),
        };
      });

    const factoryList = factories.map((f) => {
      const fMatches = matchesByFactory.get(f.id) || [];
      const connectedProjectIds = Array.from(new Set(fMatches.map((m) => m.project_id)));
      return {
        id: f.id,
        name: f.name,
        location: f.location,
        category: f.category,
        capabilities_description:
          (f.capabilities && typeof f.capabilities === "object" && (f.capabilities as { description?: string }).description) || "",
        active: f.active,
        created_at: f.created_at,
        brief_count: briefsByFactory.get(f.id) || 0,
        match_count: fMatches.length,
        connected_project_ids: connectedProjectIds,
        connected: fMatches.length > 0,
        user_id: f.user_id,
      };
    });

    const connections = matches.map((m) => {
      const pr = projectsById.get(m.project_id);
      const fac = factories.find((f) => f.id === m.factory_id);
      const buyerProfile = pr ? profiles.find((p) => p.id === pr.user_id) : null;
      return {
        id: m.id,
        status: m.status,
        quote: m.quote || {},
        created_at: m.created_at,
        project: pr ? { id: pr.id, title: pr.title, status: pr.status } : null,
        buyer: buyerProfile
          ? { id: buyerProfile.id, display_name: buyerProfile.display_name, company: companyByUser.get(buyerProfile.id)?.name || buyerProfile.company || "" }
          : null,
        factory: fac ? { id: fac.id, name: fac.name, location: fac.location, category: fac.category } : null,
      };
    });

    res.json({
      counts: {
        customers: customers.length,
        factories: factoryList.length,
        matches: matches.length,
        outreach: outreach.length,
      },
      customers,
      factories: factoryList,
      connections,
    });
  } catch (err) {
    console.error("[admin/overview]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Admin overview failed" });
  }
});

/** Full project detail for admin workspace (public route). */
adminRouter.get("/projects/:id", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  try {
    const { data: project, error: pe } = await supabaseAdmin
      .from("projects")
      .select(
        `
        *,
        companies (*)
      `
      )
      .eq("id", projectId)
      .maybeSingle();

    if (pe || !project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const userId = project.user_id as string;

    const [{ data: buyer_profile }, { data: matches }, { data: conversations }, { data: sourcing_candidates }] = await Promise.all([
      supabaseAdmin.from("profiles").select("*").eq("id", userId).maybeSingle(),
      supabaseAdmin
        .from("matches")
        .select("id, status, quote, context_summary, created_at, factory_id, factories(*)")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("conversations")
        .select("id, role, content, metadata, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("sourcing_candidates")
        .select("id, project_id, source, factory_id, supplier_url, supplier_name, supplier_location, reasoning, status, created_at, decided_at, factories(id, name, location, category)")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
    ]);

    const files = await listFilesForProjectWithUrls(projectId);

    res.json({
      project,
      company: project.companies,
      buyer_profile: buyer_profile || null,
      matches: matches || [],
      conversations: conversations || [],
      sourcing_candidates: sourcing_candidates || [],
      files,
    });
  } catch (err) {
    console.error("[admin/projects/:id]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to load project" });
  }
});

adminRouter.patch("/projects/:id/pipeline", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const step = (req.body as { pipeline_step?: unknown })?.pipeline_step;
  const n = typeof step === "number" ? step : typeof step === "string" ? parseInt(step, 10) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 3) {
    res.status(400).json({ error: "pipeline_step must be 1, 2, or 3" });
    return;
  }
  const { data, error } = await supabaseAdmin
    .from("projects")
    .update({ pipeline_step: n })
    .eq("id", projectId)
    .select("id, pipeline_step")
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(data);
});

adminRouter.patch("/projects/:id/coordination", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const mode = (req.body as { coordination_mode?: string })?.coordination_mode;
  if (mode !== "ai" && mode !== "supi_manual") {
    res.status(400).json({ error: "coordination_mode must be ai or supi_manual" });
    return;
  }
  const { data, error } = await supabaseAdmin
    .from("projects")
    .update({ coordination_mode: mode })
    .eq("id", projectId)
    .select("id, coordination_mode")
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(data);
});

adminRouter.post("/projects/:id/messages", async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const bodyText = (req.body as { body?: string })?.body;
  const text = typeof bodyText === "string" ? bodyText.trim() : "";
  if (!text) {
    res.status(400).json({ error: "body is required" });
    return;
  }

  const { data: project, error: pe } = await supabaseAdmin.from("projects").select("id, user_id").eq("id", projectId).maybeSingle();
  if (pe || !project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { data: row, error: insErr } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: project.user_id,
      project_id: projectId,
      is_supi_connection: false,
      role: "assistant",
      content: text,
      metadata: { supi: true, from_admin: true },
    })
    .select("id, role, content, metadata, created_at")
    .single();

  if (insErr) {
    res.status(500).json({ error: insErr.message });
    return;
  }
  res.json({ message: row });
});

/** Admin: post a Supi reply in the buyer's user-level Connections thread. */
adminRouter.post("/users/:userId/supi-messages", async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const bodyText = (req.body as { body?: string })?.body;
  const text = typeof bodyText === "string" ? bodyText.trim() : "";
  if (!userId?.trim() || !text) {
    res.status(400).json({ error: "userId and body are required" });
    return;
  }

  const { data: row, error: insErr } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId.trim(),
      project_id: null,
      is_supi_connection: true,
      role: "assistant",
      content: text,
      metadata: { supi: true, from_admin: true },
    })
    .select("id, role, content, metadata, created_at")
    .single();

  if (insErr) {
    res.status(500).json({ error: insErr.message });
    return;
  }
  res.json({ message: row });
});

adminRouter.post("/matches", async (req: Request, res: Response) => {
  const project_id = (req.body as { project_id?: string })?.project_id;
  const factoryRaw = (req.body as { factory_id?: unknown })?.factory_id;
  const factory_id = typeof factoryRaw === "number" ? factoryRaw : typeof factoryRaw === "string" ? parseInt(factoryRaw, 10) : NaN;

  if (!project_id?.trim() || !Number.isFinite(factory_id)) {
    res.status(400).json({ error: "project_id and factory_id are required" });
    return;
  }

  const { data: existing } = await supabaseAdmin
    .from("matches")
    .select("id, project_id, factory_id, status")
    .eq("project_id", project_id)
    .eq("factory_id", factory_id)
    .maybeSingle();

  if (existing) {
    res.json({ match: existing, deduped: true });
    return;
  }

  const { data: created, error } = await supabaseAdmin
    .from("matches")
    .insert({
      project_id,
      factory_id,
      status: "pending",
      quote: {},
      context_summary: { source: "admin_manual" },
    })
    .select("id, project_id, factory_id, status")
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ match: created, deduped: false });
});

// ──────────────────────────────────────────
// Sourcing (admin-only): platform-first lookup, then Claude web search on
// JD / Canton Fair only when no platform match exists. Admin reviews + approves.
// ──────────────────────────────────────────

adminRouter.get("/projects/:id/sourcing-candidates", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: "project id is required" });
    return;
  }
  const { data, error } = await supabaseAdmin
    .from("sourcing_candidates")
    .select("id, project_id, source, factory_id, supplier_url, supplier_name, supplier_location, reasoning, status, created_at, decided_at, factories(id, name, location, category)")
    .eq("project_id", id)
    .order("created_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ candidates: data || [] });
});

adminRouter.post("/projects/:id/source", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: "project id is required" });
    return;
  }
  const force = !!(req.body as { force?: boolean })?.force;
  try {
    const result = await runSourcingForProject(id, { force });
    const { data: candidates } = await supabaseAdmin
      .from("sourcing_candidates")
      .select("id, project_id, source, factory_id, supplier_url, supplier_name, supplier_location, reasoning, status, created_at, decided_at, factories(id, name, location, category)")
      .eq("project_id", id)
      .order("created_at", { ascending: false });
    res.json({ result, candidates: candidates || [] });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Sourcing failed" });
  }
});

adminRouter.post("/sourcing-candidates/:id/approve", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: "candidate id is required" });
    return;
  }
  try {
    const out = await approveSourcingCandidate(id);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Approve failed" });
  }
});

adminRouter.post("/sourcing-candidates/:id/reject", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: "candidate id is required" });
    return;
  }
  try {
    await rejectSourcingCandidate(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Reject failed" });
  }
});

/** Soft-delete a customer profile (moves to bin). */
adminRouter.delete("/customers/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
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

/** Soft-delete a factory (moves to bin). */
adminRouter.delete("/factories/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from("factories")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", String(id));
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

/** List everything currently in the bin (soft-deleted). */
adminRouter.get("/bin", async (_req, res: Response) => {
  const [custRes, facRes] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, display_name, company, headline, location, deleted_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
    supabaseAdmin
      .from("factories")
      .select("id, user_id, name, location, category, deleted_at")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }),
  ]);
  if (custRes.error && isMissingDeletedAtColumnError(custRes.error)) {
    res.json({ customers: [], factories: [], hint: SOFT_DELETE_MIGRATION_HINT });
    return;
  }
  if (facRes.error && isMissingDeletedAtColumnError(facRes.error)) {
    res.json({ customers: [], factories: [], hint: SOFT_DELETE_MIGRATION_HINT });
    return;
  }
  if (custRes.error) {
    res.status(500).json({ error: custRes.error.message });
    return;
  }
  if (facRes.error) {
    res.status(500).json({ error: facRes.error.message });
    return;
  }
  res.json({
    customers: custRes.data || [],
    factories: facRes.data || [],
  });
});

/** Restore a customer from the bin. */
adminRouter.post("/bin/customers/:id/restore", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ deleted_at: null })
    .eq("id", id);
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

/** Restore a factory from the bin. */
adminRouter.post("/bin/factories/:id/restore", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from("factories")
    .update({ deleted_at: null })
    .eq("id", String(id));
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

/** Permanently delete a customer (hard-delete profile row + auth user). */
adminRouter.delete("/bin/customers/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  // Delete profile row first, then remove auth user
  await supabaseAdmin.from("profiles").delete().eq("id", id);
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

/** Permanently delete a factory row (hard-delete). */
adminRouter.delete("/bin/factories/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { error } = await supabaseAdmin
    .from("factories")
    .delete()
    .eq("id", String(id));
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

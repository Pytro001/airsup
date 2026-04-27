import { Router } from "express";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../services/supabase.js";
import { isMissingDeletedAtColumnError, SOFT_DELETE_MIGRATION_HINT } from "../lib/soft-delete-errors.js";

export const adminRouter = Router();

type ProfileForAdmin = {
  id: string;
  display_name: string | null;
  company: string | null;
  headline: string | null;
  role: string | null;
  location: string | null;
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
    const [companiesRes, projectsRes, matchesRes, outreachRes] = await Promise.all([
      supabaseAdmin
        .from("companies")
        .select("id, user_id, name, description, industry, location, created_at")
        .limit(500),
      supabaseAdmin
        .from("projects")
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

    if (companiesRes.error) {
      console.error("[admin/overview] companies:", companiesRes.error);
      return res.status(500).json({ error: "companies: " + companiesRes.error.message });
    }
    if (projectsRes.error) {
      console.error("[admin/overview] projects:", projectsRes.error);
      return res.status(500).json({ error: "projects: " + projectsRes.error.message });
    }
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
        .select("id, display_name, company, headline, role, location, created_at, deleted_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (r1.error) {
        const r2 = await supabaseAdmin
          .from("profiles")
          .select("id, display_name, company, headline, role, location, created_at")
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
    const projects = projectsRes.data || [];
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
          created_at: p.created_at,
          project_count: myProjects.length,
          project_titles: myProjects.map((pr) => pr.title).slice(0, 6),
          match_count: myMatches.length,
          connected_factory_ids: connectedFactoryIds,
          connected: myMatches.length > 0,
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

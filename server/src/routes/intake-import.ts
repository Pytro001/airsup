import { Router } from "express";
import type { Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { supabaseAdmin } from "../services/supabase.js";
import { fetchChatShare, UnsupportedShareError, detectProvider } from "../lib/chat-share.js";
import { importBriefFromText } from "../agents/import-brief.js";
import { mergeSearchCriteriaFromSources } from "../lib/search-criteria.js";
import { runJobPollOnce } from "../jobs/poll.js";
import { seedSupiWelcome } from "../lib/supi-seed.js";

export const intakeImportRouter = Router();

const BRIEF_RAW_MAX = 64_000;

intakeImportRouter.post("/import", requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const body = (req.body || {}) as { sourceType?: string; url?: string; text?: string };
  const sourceType = String(body.sourceType || "").toLowerCase();
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";

  let raw = "";
  let briefSourceType: "url" | "text" | "file" = "text";
  let briefSourceUrl: string | null = null;

  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      res.status(400).json({ error: "Invalid URL" });
      return;
    }
    if (detectProvider(u) !== "unknown") {
      try {
        briefSourceType = "url";
        briefSourceUrl = url;
        const { text: t } = await fetchChatShare(url);
        raw = t;
      } catch (e) {
        if (e instanceof UnsupportedShareError) {
          if (text) {
            briefSourceType = sourceType === "file" ? "file" : "text";
            raw = text;
          } else {
            res.status(422).json({ error: e.message });
            return;
          }
        } else {
          throw e;
        }
      }
    } else if (text) {
      briefSourceType = sourceType === "file" ? "file" : "text";
      raw = text;
    } else {
      res
        .status(400)
        .json({ error: "Use a public share link from ChatGPT, Claude, or Grok, or paste the conversation as text below." });
      return;
    }
  } else if (text) {
    briefSourceType = sourceType === "file" ? "file" : "text";
    raw = text;
  } else {
    res.status(400).json({ error: "Add a public share link from ChatGPT, Claude, or Grok, or paste your chat in the text box." });
    return;
  }

  if (!raw.trim()) {
    res.status(400).json({ error: "No conversation text to import. Paste the chat or use a working share link." });
    return;
  }

  const briefRaw = raw.length > BRIEF_RAW_MAX ? raw.slice(0, BRIEF_RAW_MAX) : raw;
  const brief = await importBriefFromText(raw, userId);

  const { data: company } = await supabaseAdmin.from("companies").select("id").eq("user_id", userId).maybeSingle();
  const companyId = company?.id || null;
  if (!companyId) {
    res.status(400).json({ error: "Complete company step first, then import your brief again." });
    return;
  }

  const requirements: Record<string, string> = {};
  if (brief.quantity) requirements.quantity = brief.quantity;
  if (brief.timeline) requirements.timeline = brief.timeline;
  if (brief.budget) requirements.budget = brief.budget;
  if (brief.quality_requirements) requirements.quality_requirements = brief.quality_requirements;
  if (brief.materials) requirements.materials = brief.materials;
  if (brief.product_type) requirements.product_type = brief.product_type;
  if (brief.additional_notes) requirements.additional_notes = brief.additional_notes;

  const ai_summary: Record<string, unknown> = {
    product: brief.product_type,
    quantity: brief.quantity,
    budget: brief.budget,
    timeline: brief.timeline,
    key_requirements: brief.key_requirements,
    ideal_factory_profile: brief.ideal_factory_profile,
    readiness: brief.readiness,
  };

  const { data: projectRow, error: pe } = await supabaseAdmin
    .from("projects")
    .insert({
      user_id: userId,
      company_id: companyId,
      title: brief.title,
      description: brief.description,
      requirements,
      ai_summary,
      status: "intake",
      brief_source_type: briefSourceType,
      brief_source_url: briefSourceUrl,
      brief_raw: briefRaw,
      pipeline_step: 1,
      coordination_mode: "supi_manual",
    })
    .select("id, title, description, requirements, ai_summary")
    .single();

  if (pe || !projectRow) {
    console.error("[intake-import] project insert:", pe);
    res.status(500).json({ error: pe?.message || "Could not create project" });
    return;
  }

  await seedSupiWelcome(projectRow.id, userId);

  const project = projectRow as {
    id: string;
    title: string;
    description: string;
    requirements: Record<string, unknown> | null;
    ai_summary: Record<string, unknown> | null;
  };

  const { data: companyRow } = await supabaseAdmin
    .from("companies")
    .select("name, description, industry, location, ai_knowledge")
    .eq("id", companyId)
    .maybeSingle();

  const merged = mergeSearchCriteriaFromSources(undefined, project, companyRow);

  const { data: search, error: se } = await supabaseAdmin
    .from("factory_searches")
    .insert({ project_id: project.id, search_criteria: merged, status: "pending" })
    .select("id")
    .single();

  if (se || !search) {
    console.error("[intake-import] factory_searches insert:", se);
    res.status(500).json({ error: se?.message || "Project created but search could not start" });
    return;
  }

  await supabaseAdmin.from("projects").update({ status: "searching" }).eq("id", project.id);

  const kick = process.env.RUN_JOB_POLL_AFTER_SEARCH === "1" || (process.env.NODE_ENV !== "production" && !process.env.VERCEL);
  if (kick) {
    void runJobPollOnce().catch((err) => console.error("[Airsup] post-intake-import job poll:", err));
  }

  res.json({
    projectId: project.id,
    title: project.title,
    requirements: project.requirements,
  });
});

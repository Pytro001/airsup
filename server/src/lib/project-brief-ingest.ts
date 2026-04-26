import { supabaseAdmin } from "../services/supabase.js";
import { importBriefFromText, type ImportedBrief } from "../agents/import-brief.js";
import { mergeSearchCriteriaFromSources } from "../lib/search-criteria.js";
import { extractTextFromFileBuffer } from "../lib/file-text-extract.js";

export const BRIEF_RAW_MAX = 64_000;
const BOOTSTRAP_DESCRIPTION =
  "Your reference files are attached. Open chat to add details and refine the factory search.";

function appendBriefSection(existing: string | null, header: string, body: string): string {
  const chunk = body.trim();
  if (!chunk) return existing || "";
  const sep = existing && existing.trim() ? "\n\n---\n" : "";
  const head = `[${header}]\n`;
  const next = `${(existing || "").trim()}${sep}${head}${chunk}`;
  return next.length > BRIEF_RAW_MAX ? next.slice(0, BRIEF_RAW_MAX) : next;
}

function mergeRequirements(
  existing: Record<string, unknown> | null,
  brief: ImportedBrief
): Record<string, string> {
  const out: Record<string, string> = {};
  const prev = existing && typeof existing === "object" ? existing : {};
  for (const [k, v] of Object.entries(prev)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  const add = (k: string, v: string | null) => {
    if (v && String(v).trim()) out[k] = String(v).trim();
  };
  add("quantity", brief.quantity);
  add("timeline", brief.timeline);
  add("budget", brief.budget);
  add("quality_requirements", brief.quality_requirements);
  add("materials", brief.materials);
  add("product_type", brief.product_type);
  add("additional_notes", brief.additional_notes);
  return out;
}

function mergeAiSummary(
  existing: Record<string, unknown> | null,
  brief: ImportedBrief
): Record<string, unknown> {
  const prev = existing && typeof existing === "object" ? { ...existing } : {};
  const oldKeys = Array.isArray(prev.key_requirements)
    ? (prev.key_requirements as unknown[]).map((x) => String(x).trim()).filter(Boolean)
    : [];
  const mergedKeys = [...new Set([...oldKeys, ...brief.key_requirements])].slice(0, 12);

  return {
    ...prev,
    product: brief.product_type ?? prev.product,
    quantity: brief.quantity ?? prev.quantity,
    budget: brief.budget ?? prev.budget,
    timeline: brief.timeline ?? prev.timeline,
    key_requirements: mergedKeys,
    ideal_factory_profile: brief.ideal_factory_profile ?? prev.ideal_factory_profile,
    readiness: brief.readiness || prev.readiness || "low",
  };
}

function isBootstrapTitle(title: string): boolean {
  const t = (title || "").trim();
  return t === "New project" || /^Project —/i.test(t);
}

function shouldReplaceBootstrapDescription(desc: string): boolean {
  const d = (desc || "").trim();
  return d === BOOTSTRAP_DESCRIPTION || d.length < 40;
}

/**
 * After updating project row, refresh factory_searches.search_criteria only when the latest
 * search for this project is still `pending` (worker has not started). Avoids duplicate outreach
 * when a search is already in_progress or completed.
 */
async function refreshPendingSearchCriteria(
  projectId: string,
  project: { title: string; description: string; requirements: Record<string, unknown> | null; ai_summary: Record<string, unknown> | null },
  companyRow: {
    name: string;
    description: string | null;
    industry: string | null;
    location: string | null;
    ai_knowledge: Record<string, unknown> | null;
  } | null
): Promise<void> {
  const { data: latest, error } = await supabaseAdmin
    .from("factory_searches")
    .select("id, status")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !latest || latest.status !== "pending") return;

  const merged = mergeSearchCriteriaFromSources(undefined, project, companyRow);
  await supabaseAdmin.from("factory_searches").update({ search_criteria: merged }).eq("id", latest.id);
}

/**
 * Append extracted or pasted text to brief_raw, run importBriefFromText on combined brief, merge into project.
 */
export async function ingestRawTextIntoProject(
  userId: string,
  projectId: string,
  rawChunk: string,
  header: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = rawChunk.trim();
  if (!trimmed) return { ok: false, error: "No text to ingest." };

  const { data: row, error: pe } = await supabaseAdmin
    .from("projects")
    .select("id, user_id, title, description, requirements, ai_summary, brief_raw, company_id")
    .eq("id", projectId)
    .eq("user_id", userId)
    .single();

  if (pe || !row) {
    return { ok: false, error: "Project not found." };
  }

  const companyId = (row as { company_id: string | null }).company_id;
  const { data: companyRow } = companyId
    ? await supabaseAdmin
        .from("companies")
        .select("name, description, industry, location, ai_knowledge")
        .eq("id", companyId)
        .maybeSingle()
    : { data: null };

  const briefRaw = appendBriefSection((row as { brief_raw: string | null }).brief_raw, header, trimmed);
  const combinedForLlm = briefRaw.length > 200_000 ? briefRaw.slice(-200_000) : briefRaw;

  const brief = await importBriefFromText(combinedForLlm, userId);
  const requirements = mergeRequirements((row as { requirements: Record<string, unknown> | null }).requirements, brief);
  const ai_summary = mergeAiSummary((row as { ai_summary: Record<string, unknown> | null }).ai_summary, brief);

  let title = (row as { title: string }).title;
  if (isBootstrapTitle(title) && brief.title) title = brief.title;

  let description = (row as { description: string }).description;
  if (shouldReplaceBootstrapDescription(description)) {
    description = brief.description;
  } else if (brief.description && !description.includes(brief.description.slice(0, 40))) {
    description = `${description}\n\n${brief.description}`.slice(0, 8000);
  }

  const { error: upErr } = await supabaseAdmin
    .from("projects")
    .update({
      brief_raw: briefRaw,
      title,
      description,
      requirements,
      ai_summary,
    })
    .eq("id", projectId)
    .eq("user_id", userId);

  if (upErr) {
    return { ok: false, error: upErr.message };
  }

  await refreshPendingSearchCriteria(projectId, { title, description, requirements, ai_summary }, companyRow);

  return { ok: true };
}

/** Download from Storage, extract text, merge into project; mark project_files row ingested. */
export async function ingestRegisteredProjectFile(
  userId: string,
  projectId: string,
  fileRowId: string,
  storagePath: string,
  filename: string,
  mimeType: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from("project-files").download(storagePath);
  if (dlErr || !blob) {
    console.error("[ingest] download", storagePath, dlErr?.message);
    await supabaseAdmin.from("project_files").update({ brief_ingested_at: new Date().toISOString() }).eq("id", fileRowId);
    return { ok: true };
  }

  const buf = Buffer.from(await blob.arrayBuffer());
  const text = await extractTextFromFileBuffer(buf, { filename, mimeType });
  if (!text.trim()) {
    await supabaseAdmin.from("project_files").update({ brief_ingested_at: new Date().toISOString() }).eq("id", fileRowId);
    return { ok: true };
  }

  const out = await ingestRawTextIntoProject(userId, projectId, text, `File: ${filename}`);
  if (!out.ok) return out;

  await supabaseAdmin.from("project_files").update({ brief_ingested_at: new Date().toISOString() }).eq("id", fileRowId);
  return { ok: true };
}

/** Process all project_files for project where brief_ingested_at is null. */
export async function reingestPendingProjectFiles(userId: string, projectId: string): Promise<{ processed: number }> {
  const { data: rows, error } = await supabaseAdmin
    .from("project_files")
    .select("id, storage_path, filename, mime_type")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .is("brief_ingested_at", null);

  if (error || !rows?.length) return { processed: 0 };

  let n = 0;
  for (const r of rows) {
    const res = await ingestRegisteredProjectFile(
      userId,
      projectId,
      r.id as string,
      r.storage_path as string,
      (r.filename as string) || "file",
      (r.mime_type as string) || ""
    );
    if (res.ok) n += 1;
  }
  return { processed: n };
}

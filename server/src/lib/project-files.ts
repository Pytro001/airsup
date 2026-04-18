import { supabaseAdmin } from "../services/supabase.js";

const BUCKET = "project-files";
const SIGNED_URL_SECS = 60 * 60 * 24 * 7; // 7 days

export function safeFileSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export type ProjectFileRow = {
  id: string;
  filename: string;
  bytes: number | null;
  mime_type: string | null;
  storage_path: string;
  project_id: string | null;
  created_at: string;
};

export async function signFileUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_SECS);
  if (error) {
    console.error("[Airsup] signFileUrl:", error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

/** Validate client upload path and insert project_files (bytes go to Storage directly, not Vercel). */
export async function registerProjectFileRecord(input: {
  userId: string;
  storage_path: string;
  filename: string;
  bytes: number;
  mime_type: string;
  source: "chat" | "manual";
  /** Omit or null with orphan path; UUID must match path segment when set */
  project_id?: string | null;
}): Promise<{ ok: true; id: string; signed_url: string | null } | { ok: false; status: number; error: string }> {
  const { userId, storage_path, filename, bytes, mime_type, source, project_id: bodyProjectId } = input;
  const parts = storage_path.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== userId) {
    return { ok: false, status: 403, error: "Invalid storage path" };
  }

  const seg = parts[1];
  let resolvedProjectId: string | null = null;

  if (seg === "orphan") {
    if (bodyProjectId != null && bodyProjectId !== "") {
      return { ok: false, status: 400, error: "orphan path cannot include project_id" };
    }
    resolvedProjectId = null;
  } else {
    const pathProjectId = seg;
    if (bodyProjectId != null && bodyProjectId !== "" && bodyProjectId !== pathProjectId) {
      return { ok: false, status: 400, error: "project_id does not match path" };
    }
    resolvedProjectId = pathProjectId;
    const { data: proj, error: pe } = await supabaseAdmin
      .from("projects")
      .select("id")
      .eq("id", resolvedProjectId)
      .eq("user_id", userId)
      .maybeSingle();
    if (pe || !proj) {
      return { ok: false, status: 404, error: "Project not found" };
    }
  }

  const { data: row, error: insErr } = await supabaseAdmin
    .from("project_files")
    .insert({
      user_id: userId,
      project_id: resolvedProjectId,
      storage_path,
      filename,
      mime_type: mime_type || "",
      bytes: bytes ?? 0,
      source,
    })
    .select("id")
    .single();

  if (insErr || !row) {
    let msg = insErr?.message || "Could not save file metadata";
    if (/row-level security|violates row-level security policy/i.test(msg)) {
      msg +=
        " If this is not a duplicate path, verify Vercel env SUPABASE_SERVICE_ROLE_KEY is the Supabase service_role secret (not the anon key).";
    }
    const dup = insErr?.code === "23505" || /duplicate|unique/i.test(msg);
    return { ok: false, status: dup ? 409 : 500, error: msg };
  }

  const signed_url = await signFileUrl(storage_path);
  return { ok: true, id: row.id, signed_url };
}

export async function listFilesForProjectWithUrls(projectId: string): Promise<
  Array<ProjectFileRow & { signed_url: string | null }>
> {
  const { data: rows, error } = await supabaseAdmin
    .from("project_files")
    .select("id, filename, bytes, mime_type, storage_path, project_id, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error || !rows?.length) return [];

  const out: Array<ProjectFileRow & { signed_url: string | null }> = [];
  for (const row of rows) {
    const signed_url = await signFileUrl(row.storage_path);
    out.push({ ...row, signed_url });
  }
  return out;
}

/** Text block for AI prompts (no signed URLs — filenames + project only). */
export async function formatFilesForPrompt(userId: string): Promise<string> {
  const { data: rows, error } = await supabaseAdmin
    .from("project_files")
    .select("id, filename, bytes, project_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error || !rows?.length) return "";

  const ids = [...new Set(rows.map((r) => r.project_id).filter((x): x is string => Boolean(x)))];
  let titleMap: Record<string, string> = {};
  if (ids.length) {
    const { data: projects } = await supabaseAdmin.from("projects").select("id, title").in("id", ids);
    titleMap = Object.fromEntries((projects || []).map((p) => [p.id, p.title]));
  }

  const lines = rows.map((r) => {
    const title = r.project_id ? titleMap[r.project_id] || "Project" : "Unassigned";
    const sz = r.bytes != null ? ` (${formatBytes(r.bytes)})` : "";
    return `- ${r.filename}${sz} — ${title}`;
  });

  return (
    "## Files uploaded by this buyer\n" +
    lines.join("\n") +
    "\n(These files are stored in Airsup; matched suppliers can open them from the project or connection flow.)\n"
  );
}

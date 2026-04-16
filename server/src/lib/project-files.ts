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

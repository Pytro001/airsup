import { supabaseAdmin } from "../services/supabase.js";

const PER_PAGE = 200;

function abandonedSignupAgeMs(): number {
  const minRaw = process.env.CLEANUP_ANON_MINUTES;
  if (minRaw != null && String(minRaw).trim() !== "") {
    const m = Math.max(1, parseInt(String(minRaw), 10) || 0);
    return m * 60 * 1000;
  }
  const h = Math.max(1, parseInt(process.env.CLEANUP_ANON_HOURS || "1", 10) || 1);
  return h * 60 * 60 * 1000;
}

/**
 * Remove auth users who are still anonymous and older than the configured window.
 * Users who set a phone password (linked email) are not anonymous and are never deleted.
 */
export async function cleanupStaleAnonymousUsers(): Promise<{
  scanned: number;
  deleted: number;
  errors: number;
  thresholdIso: string;
}> {
  const ageMs = abandonedSignupAgeMs();
  const threshold = new Date(Date.now() - ageMs);
  const thresholdIso = threshold.toISOString();
  let scanned = 0;
  let deleted = 0;
  let errors = 0;
  let page = 1;

  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) {
      console.error("[cleanup-anonymous] listUsers:", error);
      throw error;
    }
    const list = data?.users ?? [];
    if (list.length === 0) break;

    for (const u of list) {
      scanned++;
      const uid = (u as { id?: string }).id;
      if (!uid) continue;

      const isAnon = (u as { is_anonymous?: boolean }).is_anonymous === true;
      if (!isAnon) continue;

      const createdAt = (u as { created_at?: string }).created_at;
      if (!createdAt) continue;
      if (new Date(createdAt) > threshold) continue;

      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(uid);
      if (delErr) {
        console.error("[cleanup-anonymous] deleteUser", uid, delErr);
        errors++;
      } else {
        deleted++;
      }
    }

    if (list.length < PER_PAGE) break;
    page++;
  }

  console.log(
    `[cleanup-anonymous] done threshold<=${thresholdIso} scanned=${scanned} deleted=${deleted} errors=${errors}`
  );
  return { scanned, deleted, errors, thresholdIso };
}

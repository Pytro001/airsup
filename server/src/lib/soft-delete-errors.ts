/** Shown when profiles/factories.deleted_at is missing in the hosted DB (migration not applied). */
export const SOFT_DELETE_MIGRATION_HINT =
  "Run the SQL in supabase/migrations/020_ensure_soft_delete_columns.sql in the Supabase SQL Editor, then wait a few seconds for the schema cache to refresh.";

/** Postgrest splits some failures across `message`, `details`, and `hint`; use full text for detection. */
export function postgrestErrorText(
  err: { message?: string; details?: string; hint?: string; code?: string } | null | undefined
): string {
  if (!err) return "";
  return [err.message, err.details, err.hint, err.code].filter(Boolean).join(" | ");
}

export function isMissingDeletedAtColumnError(err: { message?: string; details?: string; hint?: string } | null): boolean {
  const m = postgrestErrorText(err).toLowerCase();
  return (
    m.includes("deleted_at") &&
    (m.includes("schema cache") || m.includes("column") || m.includes("could not find"))
  );
}

/** When `projects.pipeline_step` / `coordination_mode` are missing (migration 021 not applied). */
export const PROJECT_PIPELINE_MIGRATION_HINT =
  "Run supabase/migrations/021_project_pipeline_supi.sql in the Supabase SQL Editor so admin pipeline and AI coordination toggles persist.";

export function isMissingProjectsPipelineColumnError(
  err: { message?: string; details?: string; hint?: string } | null
): boolean {
  const m = postgrestErrorText(err).toLowerCase();
  return (
    (m.includes("pipeline_step") || m.includes("coordination_mode")) &&
    (m.includes("does not exist") || m.includes("could not find") || m.includes("schema cache") || m.includes("column"))
  );
}

/** Shown when profiles/factories.deleted_at is missing in the hosted DB (migration not applied). */
export const SOFT_DELETE_MIGRATION_HINT =
  "Run the SQL in supabase/migrations/020_ensure_soft_delete_columns.sql in the Supabase SQL Editor, then wait a few seconds for the schema cache to refresh.";

export function isMissingDeletedAtColumnError(err: { message?: string } | null): boolean {
  const m = (err?.message || "").toLowerCase();
  return (
    m.includes("deleted_at") &&
    (m.includes("schema cache") || m.includes("column") || m.includes("could not find"))
  );
}

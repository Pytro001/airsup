import { supabaseAdmin } from "../services/supabase.js";
import { isMissingProjectsPipelineColumnError } from "./soft-delete-errors.js";

const PIPELINE_OPTIONAL_KEYS = ["pipeline_step", "coordination_mode"] as const;

/**
 * Insert a projects row, including pipeline/coordination columns when migration 021
 * is applied. If the DB is missing those columns, retry the insert without them.
 */
export async function insertProjectWithPipelineColumnsFallback<T>(row: Record<string, unknown>, select: string) {
  const first = await supabaseAdmin.from("projects").insert(row).select(select).single();
  if (!first.error) {
    return { data: first.data as T, error: null as PostgrestError | null };
  }
  if (!isMissingProjectsPipelineColumnError(first.error)) {
    return { data: null, error: first.error };
  }
  const rest = { ...row } as Record<string, unknown>;
  for (const k of PIPELINE_OPTIONAL_KEYS) delete rest[k];
  const second = await supabaseAdmin.from("projects").insert(rest).select(select).single();
  return { data: (second.data as T) || null, error: second.error };
}

type PostgrestError = { message: string; details?: string; hint?: string; code?: string };

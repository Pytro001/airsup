import { supabaseAdmin } from "../services/supabase.js";

export const SUPI_INTRO_MESSAGE =
  "Hi, I'm Supi. I'm here if you need help with your project or the platform, just send a message anytime.";

/** Seed the first Supi message in the user-level Connections thread (not project chat). Idempotent per user. */
export async function seedSupiConnectionWelcome(userId: string): Promise<void> {
  const { count, error: cErr } = await supabaseAdmin
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("project_id", null)
    .eq("is_supi_connection", true);

  if (cErr) {
    console.error("[supi-seed] count supi conversations:", cErr);
    return;
  }
  if ((count ?? 0) > 0) return;

  const { error } = await supabaseAdmin.from("conversations").insert({
    user_id: userId,
    project_id: null,
    is_supi_connection: true,
    role: "assistant",
    content: SUPI_INTRO_MESSAGE,
    metadata: { supi: true, seed: true },
  });

  if (error) console.error("[supi-seed] insert supi welcome:", error);
}

/** @deprecated Use seedSupiConnectionWelcome(userId). projectId is ignored. */
export async function seedSupiWelcome(_projectId: string, userId: string): Promise<void> {
  return seedSupiConnectionWelcome(userId);
}

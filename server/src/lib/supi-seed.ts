import { supabaseAdmin } from "../services/supabase.js";

export const SUPI_INTRO_MESSAGE =
  "Hi — I'm Supi from Airsup. I'll coordinate your project here and keep you posted. Share what you're making, timelines, and any quantities when you're ready.";

/** Seed a single welcome assistant row for a new project (no duplicate if chat already exists). */
export async function seedSupiWelcome(projectId: string, userId: string): Promise<void> {
  const { count, error: cErr } = await supabaseAdmin
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("user_id", userId);

  if (cErr) {
    console.error("[supi-seed] count conversations:", cErr);
    return;
  }
  if ((count ?? 0) > 0) return;

  const { error } = await supabaseAdmin.from("conversations").insert({
    user_id: userId,
    project_id: projectId,
    role: "assistant",
    content: SUPI_INTRO_MESSAGE,
    metadata: { supi: true, seed: true },
  });

  if (error) console.error("[supi-seed] insert welcome:", error);
}

import { supabaseAdmin } from "../services/supabase.js";

export async function match({ projectId, componentId }: { projectId: string; componentId?: string }) {
  let categoryFilter: string | undefined;

  if (componentId) {
    const { data: component } = await supabaseAdmin
      .from("project_components")
      .select("spec")
      .eq("id", componentId)
      .single();
    categoryFilter = component?.spec?.category;
  } else {
    const { data: project } = await supabaseAdmin
      .from("projects")
      .select("category, quantity")
      .eq("id", projectId)
      .single();
    categoryFilter = project?.category;
  }

  let query = supabaseAdmin
    .from("factories")
    .select("*")
    .eq("active", true)
    .order("tier"); // A first, then B, then C

  if (categoryFilter) {
    query = query.contains("categories", [categoryFilter]);
  }

  const { data: project } = await supabaseAdmin
    .from("projects")
    .select("quantity")
    .eq("id", projectId)
    .single();

  if (project?.quantity) {
    query = query.lte("min_order_qty", project.quantity);
  }

  const { data: suppliers } = await query;
  return suppliers ?? [];
}

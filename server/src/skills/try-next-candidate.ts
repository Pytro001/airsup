import { triggerSkill } from "./runner.js";

export async function tryNextCandidate({ projectId }: { projectId: string }) {
  // Re-run match to find the next eligible supplier not yet contacted
  // For v1 this re-queries the full list; a future version could exclude already-tried suppliers
  const candidates: any[] = (await triggerSkill("match", { projectId })) ?? [];
  if (candidates.length > 0) {
    return triggerSkill("outreach", { projectId, supplierId: candidates[0].id });
  }
  console.warn(`[try-next-candidate] No further candidates for project ${projectId}`);
}

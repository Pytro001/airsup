// Central skill dispatcher — replaces @openclaw/runtime triggerSkill
type SkillHandler = (payload: any) => Promise<any>;

const registry = new Map<string, SkillHandler>();

export function registerSkill(name: string, handler: SkillHandler): void {
  registry.set(name, handler);
}

export async function triggerSkill(name: string, payload: any = {}): Promise<any> {
  const handler = registry.get(name);
  if (!handler) {
    console.error(`[Skills] No handler registered for skill: ${name}`);
    return;
  }
  try {
    return await handler(payload);
  } catch (err) {
    console.error(`[Skills] Error in skill "${name}":`, err);
  }
}

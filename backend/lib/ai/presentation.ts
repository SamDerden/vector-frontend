const INTERNAL_SKILL_ID = /^skill[_-]\d+$/i;

export function programsVisibleForTier(tier: string): boolean {
  return tier === "9-11";
}

export function publicSkillName(
  value: unknown,
  names: ReadonlyMap<string, string>
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!INTERNAL_SKILL_ID.test(trimmed)) return trimmed;
  const name = names.get(trimmed);
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export function resolveCatalogActivities(
  trials: Array<{ trial_id?: unknown; title?: unknown }>,
  ids: unknown
): Array<{ id: string; title: string }> {
  const titles = new Map<string, string>();
  for (const trial of trials) {
    if (typeof trial.trial_id !== "string" || typeof trial.title !== "string") continue;
    const title = trial.title.trim();
    if (trial.trial_id.trim() && title) titles.set(trial.trial_id, title);
  }
  const wanted = Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const seen = new Set<string>();
  return wanted.flatMap((id) => {
    if (seen.has(id)) return [];
    const title = titles.get(id);
    if (!title) return [];
    seen.add(id);
    return [{ id, title }];
  });
}

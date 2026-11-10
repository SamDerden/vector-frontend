export type GradeBand = "1-4" | "5-8" | "9-11";

export function gradeBand(grade: number): GradeBand {
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
    throw new Error("grade must be an integer from 1 to 11");
  }
  if (grade <= 4) return "1-4";
  if (grade <= 8) return "5-8";
  return "9-11";
}

export function showsProfessions(grade: number): boolean {
  return gradeBand(grade) !== "1-4";
}

export function showsEducationPrograms(grade: number): boolean {
  return gradeBand(grade) === "9-11";
}

export function interestLabels(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const labels: string[] = [];
  for (const tag of tags) {
    const text = typeof tag === "string"
      ? tag
      : tag && typeof tag === "object" && "tag" in tag && typeof tag.tag === "string"
        ? tag.tag
        : "";
    const trimmed = text.trim();
    if (trimmed && !labels.includes(trimmed)) labels.push(trimmed);
  }
  return labels;
}

export function hasActionableRoute(result: { hypotheses?: unknown; nextStepOptions?: unknown } | null | undefined): boolean {
  const hypotheses = Array.isArray(result?.hypotheses) ? result.hypotheses : [];
  const options = Array.isArray(result?.nextStepOptions) ? result.nextStepOptions : [];
  const hasTrials = hypotheses.some((item) =>
    Boolean(item) && typeof item === "object" && Array.isArray((item as { trials?: unknown }).trials) && (item as { trials: unknown[] }).trials.length > 0
  );
  const hasAvailableStep = options.some((item) =>
    Boolean(item) && typeof item === "object" && Boolean((item as { available?: unknown }).available)
  );
  return hasTrials || hasAvailableStep;
}

export function activityTitles(activities: unknown): Array<{ id: string; title: string }> {
  if (!Array.isArray(activities)) return [];
  const seen = new Set<string>();
  return activities.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = "id" in item && typeof item.id === "string" ? item.id : "";
    const title = "title" in item && typeof item.title === "string" ? item.title.trim() : "";
    if (!id || !title || seen.has(id) || title === id) return [];
    seen.add(id);
    return [{ id, title }];
  });
}

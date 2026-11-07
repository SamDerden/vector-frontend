import { NormalizedProfession } from "./catalog";

export function estimateAgeFromGrade(grade: number): number {
  return grade + 6;
}

export function isTrialEligibleForGrade(
  trial: NormalizedProfession["trials"][number],
  grade: number
): boolean {
  const estimatedAge = estimateAgeFromGrade(grade);
  return (
    (trial.age_min == null || estimatedAge >= trial.age_min) &&
    (trial.age_max == null || estimatedAge <= trial.age_max)
  );
}

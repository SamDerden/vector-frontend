// lib/ai/confidence.ts
import confidenceRules from "@/config/confidence_rules.json";

export interface ConfidenceSignals {
  match_strength: "strong" | "moderate" | "weak";
  agreement_levels: 0 | 1 | 2;
  independent_answers: number;
  empty_share: number;    // 0..1
  coverage_gap: boolean;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export function computeConfidence(signals: ConfidenceSignals): ConfidenceLevel {
  const strength = confidenceRules.signals.match_strength.mapping[signals.match_strength];

  for (const level of confidenceRules.level_selection.order as ConfidenceLevel[]) {
    const r = confidenceRules.levels[level];
    if (
      strength >= r.min_match_strength &&
      signals.agreement_levels >= r.min_agreement_levels &&
      signals.independent_answers >= r.min_independent_answers &&
      signals.empty_share <= r.max_empty_share &&
      (!signals.coverage_gap || r.coverage_gap_allowed)
    ) {
      return level;
    }
  }
  return "low";
}
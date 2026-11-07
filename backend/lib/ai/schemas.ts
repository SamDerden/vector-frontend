// lib/ai/schemas.ts
import { z } from "zod";

// ---------- Общие элементы ----------

const EvidenceRefsSchema = z.array(z.string().min(1)).min(1).max(20);

const IndustrySchema = z.object({
  industry_id: z.string(),
  why: z.string().max(400),
  evidence_refs: EvidenceRefsSchema,
});

// Схема для 1-4 классов (только теги интересов, без профессий)
export const Schema14 = z.object({
  schema_version: z.string(),
  status: z.enum(["ok", "low_signal", "no_match"]),
  summary: z.string().max(500),
  interest_tags: z.array(z.object({
    industry_id: z.string(),
    tag: z.string().max(100),
    why: z.string().max(300),
    evidence_refs: EvidenceRefsSchema,
  })),
  activity_ids: z.array(z.string()).max(10),
  next_step: z.string(),
  warnings: z.array(z.string()),
});

// Базовая гипотеза для 5-8
export const Hypothesis58 = z.object({
  profession_id: z.string(),
  industry_id: z.string(),
  why: z.string().max(400),
  evidence_refs: EvidenceRefsSchema,
  activity_links: z.array(z.object({
    type: z.string(),
    evidence_refs: EvidenceRefsSchema,
  })).max(2),
  match_strength: z.enum(["strong", "moderate", "weak"]),
  what_to_try: z.string().max(400),
  trial_ids: z.array(z.string()).max(20),
});

// Схема для 5-8
export const Schema58 = z.object({
  schema_version: z.string(),
  status: z.enum(["ok", "low_signal", "no_match"]),
  summary: z.string().max(500),
  industries: z.array(IndustrySchema),
  hypotheses: z.array(Hypothesis58).max(5),
  next_step: z.string(),
  warnings: z.array(z.string()),
});

// Гипотеза для 9-11 (добавляются программы и watch_out)
export const Hypothesis911 = Hypothesis58.extend({
  program_ids: z.array(z.string()).max(20),
  watch_out: z.string().max(400),
});

// Схема для 9-11
export const Schema911 = z.object({
  schema_version: z.string(),
  status: z.enum(["ok", "low_signal", "no_match"]),
  summary: z.string().max(500),
  industries: z.array(IndustrySchema),
  hypotheses: z.array(Hypothesis911).max(5),
  next_step: z.string(),
  path_note: z.string(),
  warnings: z.array(z.string()),
});

// Универсальный тип ответа
export type LLMResponse = z.infer<typeof Schema14> | z.infer<typeof Schema58> | z.infer<typeof Schema911>;
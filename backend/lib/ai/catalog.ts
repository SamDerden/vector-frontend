import { z } from "zod";

const RelatedProfessionSchema = z.object({
  profession_id: z.string().min(1),
  fit_level: z.enum(["прямая", "смежная"]).optional(),
  skills_checked: z.array(z.string()).optional(),
}).passthrough();

const OrganizationSchema = z.object({
  organization_id: z.string().min(1),
  name: z.string().min(1),
  org_type: z.string().optional(),
  municipality: z.string().optional(),
  address: z.string().optional(),
  website: z.string().optional(),
}).passthrough();

const SkillSchema = z.object({
  skill_id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().optional(),
  importance: z.number().optional(),
  description_kid: z.string().optional(),
  description_1_4: z.string().optional(),
  description_5_8: z.string().optional(),
  description_9_11: z.string().optional(),
}).passthrough();

const TrialSchema = z.object({
  trial_id: z.string().min(1),
  title: z.string().min(1),
  format: z.string().optional(),
  duration_minutes: z.number().nullable().optional(),
  age_min: z.number().nullable().optional(),
  age_max: z.number().nullable().optional(),
  municipality: z.string().optional(),
  cost: z.string().optional(),
  description_1_4: z.string().optional(),
  description_5_8: z.string().optional(),
  description_9_11: z.string().optional(),
  keywords: z.string().optional(),
  source_url: z.string().optional(),
  trial_type: z.string().nullable().optional(),
  organization: OrganizationSchema.optional(),
  organization_name: z.string().optional(),
  skills_checked: z.array(z.string()).optional(),
  fit_level: z.enum(["прямая", "смежная"]).nullable().optional(),
  professions: z.array(RelatedProfessionSchema).optional(),
}).passthrough();

const ProgramSchema = z.object({
  program_id: z.string().min(1),
  name: z.string().min(1),
  level: z.string().optional(),
  specialty_code: z.string().nullable().optional(),
  duration_years: z.number().nullable().optional(),
  fit_level: z.enum(["прямая", "смежная"]).nullable().optional(),
  organization: OrganizationSchema.optional(),
  organization_name: z.string().optional(),
  professions: z.array(RelatedProfessionSchema).optional(),
}).passthrough();

const ProfessionSchema = z.object({
  profession_id: z.string().min(1),
  name: z.string().min(1),
  industry_id: z.string().min(1),
  industry_name: z.string().min(1),
  what_does_kid: z.string(),
  description_1_4: z.string(),
  description_5_8: z.string(),
  description_9_11: z.string(),
  riasec: z.record(z.string(), z.number().min(0).max(1)).nullable(),
  current_market_state: z.object({
    demand_level_region: z.string().nullable().optional(),
    salary_median_rub: z.number().nullable().optional(),
    vacancies_count: z.number().nullable().optional(),
  }).passthrough(),
  vacancy_history: z.array(z.object({
    source_id: z.string().nullable().optional(),
  }).passthrough()).optional(),
  skills: z.array(SkillSchema),
  programs: z.array(ProgramSchema),
  trials: z.array(TrialSchema),
}).passthrough();

const IndustrySchema = z.object({
  industry_id: z.string().min(1),
  name: z.string().min(1),
  description_kid: z.string().optional(),
  regional_importance: z.string().optional(),
}).passthrough();

const SourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

export const HybridGraphSchema = z.object({
  meta: z.object({
    version: z.string().min(1),
    schema: z.literal("hybrid_v2"),
    generated_at: z.string().optional(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
  }).passthrough(),
  industries: z.array(IndustrySchema),
  skills: z.array(SkillSchema),
  organizations: z.array(OrganizationSchema),
  professions: z.array(ProfessionSchema),
  education_programs: z.array(ProgramSchema),
  trials: z.array(TrialSchema),
  source_registry: z.array(SourceSchema).optional(),
}).passthrough().superRefine((graph, context) => {
  for (const entity of ["industries", "professions", "skills", "organizations", "education_programs", "trials"] as const) {
    const declared = graph.meta.counts[entity];
    if (declared !== undefined && declared !== graph[entity].length) {
      context.addIssue({
        code: "custom",
        path: ["meta", "counts", entity],
        message: `ожидалось ${graph[entity].length}, указано ${declared}`,
      });
    }
  }
  const industryIds = new Set(graph.industries.map((industry) => industry.industry_id));
  graph.professions.forEach((profession, index) => {
    if (!industryIds.has(profession.industry_id)) {
      context.addIssue({
        code: "custom",
        path: ["professions", index, "industry_id"],
        message: `неизвестная отрасль ${profession.industry_id}`,
      });
    }
  });
});

export type HybridGraph = z.infer<typeof HybridGraphSchema>;

export interface NormalizedIndustry {
  id: string;
  slug: string;
  name: string;
  description_kid: string | null;
  regional_importance: string | null;
}

export interface NormalizedProfession {
  profession_id: string;
  name: string;
  industry_id: string;
  industry_name: string;
  what_kid_does: string;
  description_1_4: string;
  description_5_8: string;
  description_9_11: string;
  riasec_profile: Record<string, number> | null;
  key_skills: string[];
  skills: HybridGraph["skills"];
  trial_ids: string[];
  program_ids: string[];
  trials: Array<HybridGraph["trials"][number] & { trial_type: string | null }>;
  programs: HybridGraph["education_programs"];
  salary_median_rub: number | null;
  demand_level: string | null;
  vacancies_count: number | null;
  source_id: string | null;
}

export interface CatalogChunk {
  type: "profession_core" | "profession_paths" | "industry_card";
  text: string;
  metadata: Record<string, unknown>;
}

export interface NormalizedCatalog {
  version: string;
  schema_version: "hybrid_v2";
  built_at: string;
  industries: NormalizedIndustry[];
  professions: NormalizedProfession[];
  skills: HybridGraph["skills"];
  organizations: HybridGraph["organizations"];
  education_programs: HybridGraph["education_programs"];
  trials: HybridGraph["trials"];
  source_registry: HybridGraph["source_registry"];
  chunks: CatalogChunk[];
}

export function normalizeHybridGraph(graph: HybridGraph): Omit<NormalizedCatalog, "version" | "built_at"> {
  const industryById = new Map(
    graph.industries.map((industry) => [industry.industry_id, industry])
  );
  const industries: NormalizedIndustry[] = graph.industries.map((industry) => ({
    id: industry.industry_id,
    slug: industry.industry_id,
    name: industry.name,
    description_kid: industry.description_kid ?? null,
    regional_importance: industry.regional_importance ?? null,
  }));
  const globalTrials = new Map(graph.trials.map((trial) => [trial.trial_id, trial]));
  const globalPrograms = new Map(
    graph.education_programs.map((program) => [program.program_id, program])
  );
  const globalTrialsByProfession = new Map<string, HybridGraph["trials"]>();
  for (const trial of graph.trials) {
    for (const link of trial.professions ?? []) {
      const linkedTrials = globalTrialsByProfession.get(link.profession_id) ?? [];
      linkedTrials.push(trial);
      globalTrialsByProfession.set(link.profession_id, linkedTrials);
    }
  }
  const professions: NormalizedProfession[] = graph.professions.map((profession) => {
    const industry = industryById.get(profession.industry_id);
    if (!industry) throw new Error(`Для профессии ${profession.profession_id} не найдена отрасль`);
    const programs = profession.programs.map((embeddedProgram) => {
      const program = globalPrograms.get(embeddedProgram.program_id) ?? embeddedProgram;
      const professionLink = program.professions?.find(
        (relatedProfession) => relatedProfession.profession_id === profession.profession_id
      );
      return {
        ...program,
        ...embeddedProgram,
        ...(professionLink?.fit_level
          ? { fit_level: professionLink.fit_level }
          : {}),
      };
    });
    const trialsById = new Map<string, NormalizedProfession["trials"][number]>();
    for (const embeddedTrial of profession.trials) {
      const trial = globalTrials.get(embeddedTrial.trial_id) ?? embeddedTrial;
      const isLinked = trial.professions?.some(
        (relatedProfession) => relatedProfession.profession_id === profession.profession_id
      );
      trialsById.set(trial.trial_id, {
        ...trial,
        ...embeddedTrial,
        ...(isLinked && trial.fit_level == null ? { fit_level: "прямая" as const } : {}),
        trial_type: trial.trial_type ?? embeddedTrial.trial_type ?? null,
      });
    }
    for (const program of programs) {
      const globalProgram = globalPrograms.get(program.program_id);
      for (const linkedProfession of globalProgram?.professions ?? []) {
        if (linkedProfession.profession_id === profession.profession_id) continue;
        for (const trial of globalTrialsByProfession.get(linkedProfession.profession_id) ?? []) {
          if (trialsById.has(trial.trial_id)) continue;
          trialsById.set(trial.trial_id, {
            ...trial,
            fit_level: "смежная",
            trial_type: trial.trial_type ?? null,
          });
        }
      }
    }
    const trials = [...trialsById.values()];
    const latestVacancy = profession.vacancy_history?.at(-1);
    const vacancySource = latestVacancy?.source_id ?? null;
    return {
      profession_id: profession.profession_id,
      name: profession.name,
      industry_id: profession.industry_id,
      industry_name: industry.name,
      what_kid_does: profession.what_does_kid,
      description_1_4: profession.description_1_4,
      description_5_8: profession.description_5_8,
      description_9_11: profession.description_9_11,
      riasec_profile: profession.riasec,
      key_skills: profession.skills
        .slice()
        .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0))
        .slice(0, 4)
        .map((skill) => skill.name),
      skills: profession.skills,
      trial_ids: trials.map((trial) => trial.trial_id),
      program_ids: programs.map((program) => program.program_id),
      trials,
      programs,
      salary_median_rub: profession.current_market_state.salary_median_rub ?? null,
      demand_level: profession.current_market_state.demand_level_region ?? null,
      vacancies_count: profession.current_market_state.vacancies_count ?? null,
      source_id: vacancySource,
    };
  });

  const chunks: CatalogChunk[] = [
    ...professions.map((profession) => ({
      type: "profession_core" as const,
      text: [
        profession.name,
        `Отрасль: ${profession.industry_name}`,
        profession.what_kid_does,
        profession.description_1_4,
        profession.description_5_8,
        profession.description_9_11,
        profession.key_skills.length ? `Навыки: ${profession.key_skills.join(", ")}` : "",
      ].filter(Boolean).join(". "),
      metadata: {
        profession_id: profession.profession_id,
        industry_id: profession.industry_id,
        trial_ids: profession.trial_ids,
        program_ids: profession.program_ids,
        source_id: profession.source_id,
        riasec_profile: profession.riasec_profile,
      },
    })),
    ...professions
      .filter((profession) => profession.trial_ids.length || profession.program_ids.length)
      .map((profession) => ({
        type: "profession_paths" as const,
        text: [
          `Пути для «${profession.name}»`,
          ...profession.programs.map((program) => program.name),
          ...profession.trials.flatMap((trial) => [
            trial.title,
            trial.keywords ?? "",
            trial.description_1_4 ?? "",
            trial.description_5_8 ?? "",
            trial.description_9_11 ?? "",
          ]),
        ].join(". "),
        metadata: {
          profession_id: profession.profession_id,
          industry_id: profession.industry_id,
          trial_ids: profession.trial_ids,
          program_ids: profession.program_ids,
          source_id: profession.source_id,
        },
      })),
    ...industries.map((industry) => ({
      type: "industry_card" as const,
      text: [
        industry.name,
        industry.description_kid ?? "",
        professions
          .filter((profession) => profession.industry_id === industry.id)
          .map((profession) => profession.name)
          .join(", "),
      ].filter(Boolean).join(". "),
      metadata: {
        industry_id: industry.id,
        profession_count: professions.filter(
          (profession) => profession.industry_id === industry.id
        ).length,
      },
    })),
  ];

  return {
    schema_version: graph.meta.schema,
    industries,
    professions,
    skills: graph.skills,
    organizations: graph.organizations,
    education_programs: graph.education_programs,
    trials: graph.trials,
    source_registry: graph.source_registry,
    chunks,
  };
}

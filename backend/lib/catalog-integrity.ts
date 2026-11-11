export type CatalogDiscrepancy = {
  kind: "duplicate" | "dangling";
  entity: "profession_id" | "program_id" | "organization_id";
  id: string;
  referencedBy: string;
};

export type CatalogAuditReport = {
  source: "catalog.normalized.json";
  version: string | null;
  counts: {
    professions: number;
    programs: number;
    organizations: number;
  };
  discrepancies: CatalogDiscrepancy[];
  database: "not_checked";
  inventedMappings: 0;
};

type IdCarrier = {
  profession_id?: unknown;
  program_id?: unknown;
  organization_id?: unknown;
  organization?: { organization_id?: unknown };
  professions?: unknown[];
};

function asId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collect(list: unknown): IdCarrier[] {
  return Array.isArray(list) ? list.filter((item): item is IdCarrier => Boolean(item) && typeof item === "object") : [];
}

export const READ_ONLY_CATALOG_SQL = [
  `SELECT graph_profession_id FROM professions WHERE graph_profession_id IS NOT NULL`,
  `SELECT id::text AS id FROM professions WHERE is_active = TRUE AND graph_profession_id IS NULL`,
  `SELECT graph_program_id FROM education_programs WHERE graph_program_id IS NOT NULL`,
  `SELECT graph_organization_id FROM organizations WHERE graph_organization_id IS NOT NULL`,
  `SELECT ep.id::text AS id
   FROM education_programs ep
   WHERE ep.profession_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM professions p WHERE p.id = ep.profession_id)`,
  `SELECT pt.id::text AS id
   FROM professional_trials pt
   WHERE pt.organization_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = pt.organization_id)`,
] as const;

export function compareCatalogIds(input: {
  jsonIds: string[];
  databaseIds: string[];
}): { missingInDatabase: string[]; missingInJson: string[] } {
  const json = new Set(input.jsonIds);
  const database = new Set(input.databaseIds);
  return {
    missingInDatabase: [...json].filter((id) => !database.has(id)).sort(),
    missingInJson: [...database].filter((id) => !json.has(id)).sort(),
  };
}

export function auditNormalizedCatalog(catalog: unknown): CatalogAuditReport {
  const root = catalog && typeof catalog === "object" ? catalog as Record<string, unknown> : {};
  const professions = collect(root.professions);
  const programs = collect(root.education_programs);
  const organizations = collect(root.organizations);
  const trials = collect(root.trials);
  const professionIds = new Set<string>();
  const programIds = new Set<string>();
  const organizationIds = new Set<string>();
  const discrepancies: CatalogDiscrepancy[] = [];

  function addUnique(
    entity: CatalogDiscrepancy["entity"],
    id: string | null,
    bucket: Set<string>,
    referencedBy: string
  ) {
    if (!id) return;
    if (bucket.has(id)) {
      discrepancies.push({ kind: "duplicate", entity, id, referencedBy });
      return;
    }
    bucket.add(id);
  }

  for (const profession of professions) addUnique("profession_id", asId(profession.profession_id), professionIds, "professions");
  for (const program of programs) addUnique("program_id", asId(program.program_id), programIds, "education_programs");
  for (const organization of organizations) {
    addUnique("organization_id", asId(organization.organization_id), organizationIds, "organizations");
  }

  function checkProfessionRef(id: string | null, referencedBy: string) {
    if (id && !professionIds.has(id)) {
      discrepancies.push({ kind: "dangling", entity: "profession_id", id, referencedBy });
    }
  }
  function checkOrganizationRef(id: string | null, referencedBy: string) {
    if (id && !organizationIds.has(id)) {
      discrepancies.push({ kind: "dangling", entity: "organization_id", id, referencedBy });
    }
  }

  for (const program of programs) {
    const programId = asId(program.program_id) ?? "unknown-program";
    checkOrganizationRef(asId(program.organization?.organization_id), `education_programs:${programId}`);
    for (const related of collect(program.professions)) {
      checkProfessionRef(asId(related.profession_id), `education_programs:${programId}`);
    }
  }
  for (const trial of trials) {
    const trialId = asId((trial as { trial_id?: unknown }).trial_id) ?? "unknown-trial";
    checkOrganizationRef(asId(trial.organization?.organization_id), `trials:${trialId}`);
    for (const related of collect(trial.professions)) {
      checkProfessionRef(asId(related.profession_id), `trials:${trialId}`);
    }
  }

  return {
    source: "catalog.normalized.json",
    version: typeof root.version === "string" ? root.version : null,
    counts: {
      professions: professionIds.size,
      programs: programIds.size,
      organizations: organizationIds.size,
    },
    discrepancies,
    database: "not_checked",
    inventedMappings: 0,
  };
}

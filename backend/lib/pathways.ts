export type PathwayType = "club" | "college" | "online_course";

export type CatalogOpportunity = {
  id: string;
  title: string;
  institution: string | null;
  level: string | null;
  url: string | null;
  organizationName: string | null;
  organizationType: string | null;
  website: string | null;
  contactEmail: string | null;
  professionIds: string[];
  format?: string | null;
};

export type PathwayOption = {
  type: PathwayType;
  available: boolean;
  id?: string;
  title?: string;
  organization?: string;
  url?: string | null;
  contactEmail?: string | null;
  format?: string | null;
  source?: "catalog" | "graph";
  note: string;
};

const UNAVAILABLE: Record<PathwayType, string> = {
  club: "В проверенном каталоге нет кружка или секции для выбранных профессий. Контакты не выдумываются.",
  college:
    "В проверенном каталоге нет колледжа (СПО) для выбранных профессий. Учебное заведение не выдумывается.",
  online_course:
    "В проверенном каталоге нет онлайн-курса с проверенной ссылкой для выбранных профессий.",
};

export function classifyOpportunity(row: {
  title?: string | null;
  institution?: string | null;
  level?: string | null;
  organizationName?: string | null;
  organizationType?: string | null;
  format?: string | null;
  url?: string | null;
}): PathwayType | "other" {
  const text = [
    row.level,
    row.title,
    row.institution,
    row.organizationName,
    row.organizationType,
    row.format,
    row.url,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/кружок|секци|доп(олнительн)?(.{0,12})образ/.test(text)) {
    return "club";
  }

  if (
    /онлайн-курс|online course/.test(text) ||
    ((/онлайн|online/.test(text)) && /курс|course|моок/.test(text))
  ) {
    return "online_course";
  }

  if (/спо|колледж|техникум|училищ/.test(text)) {
    return "college";
  }

  return "other";
}

function toOption(
  type: PathwayType,
  row: CatalogOpportunity,
  source: "catalog" | "graph"
): PathwayOption {
  const url = row.url || row.website || null;
  const contactEmail = row.contactEmail || null;
  const missingContact =
    !url && !contactEmail
      ? " Название взято из каталога, ссылка и контакт в источнике не указаны."
      : "";

  return {
    type,
    available: true,
    id: row.id,
    title: row.title,
    organization: row.organizationName || row.institution || undefined,
    url,
    contactEmail,
    format: row.format ?? row.level,
    source,
    note: `Данные из проверенного каталога.${missingContact}`,
  };
}

function pickForType(
  type: PathwayType,
  opportunities: CatalogOpportunity[],
  preferredIds: Set<string>,
  professionIds: Set<string>
): CatalogOpportunity | null {
  const matching = opportunities.filter(
    (item) => classifyOpportunity(item) === type
  );
  if (matching.length === 0) {
    return null;
  }

  const preferred = matching.find((item) => preferredIds.has(item.id));
  if (preferred) {
    return preferred;
  }

  const linked = matching.find((item) =>
    item.professionIds.some((id) => professionIds.has(id))
  );
  return linked ?? matching[0];
}

export function buildPathwayOptions(params: {
  opportunities: CatalogOpportunity[];
  preferredProgramIds?: Array<string | null | undefined>;
  professionIds: string[];
  graphFallbacks?: Partial<Record<PathwayType, CatalogOpportunity | null>>;
}): PathwayOption[] {
  const preferredIds = new Set(
    (params.preferredProgramIds ?? []).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    )
  );
  const professionIds = new Set(params.professionIds);
  const types: PathwayType[] = ["club", "college", "online_course"];

  return types.map((type) => {
    const fromCatalog = pickForType(
      type,
      params.opportunities,
      preferredIds,
      professionIds
    );
    if (fromCatalog) {
      return toOption(type, fromCatalog, "catalog");
    }

    const fromGraph = params.graphFallbacks?.[type];
    if (fromGraph) {
      return toOption(type, fromGraph, "graph");
    }

    return {
      type,
      available: false,
      note: UNAVAILABLE[type],
    };
  });
}

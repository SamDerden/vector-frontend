export function normalizeTitle(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
}

export function planHybridProfessionImport({
  existingProfessions,
  industries,
  graphProfessions,
}) {
  const blocked = [];
  const links = [];
  const inserts = [];
  const unchanged = [];
  const industryIds = new Set(
    industries
      .map((industry) => industry.externalId)
      .filter((externalId) => typeof externalId === "string" && externalId.length > 0)
  );
  const byTitle = groupBy(existingProfessions, (row) => normalizeTitle(row.title));
  const externalIds = new Set(
    existingProfessions
      .map((row) => row.externalId)
      .filter((externalId) => typeof externalId === "string" && externalId.length > 0)
  );
  const seenGraphIds = new Set();

  for (const profession of graphProfessions) {
    const graphProfessionId = profession.professionId;
    const title = String(profession.name ?? "").trim();
    if (!graphProfessionId || !title || !profession.industryId) {
      blocked.push({
        code: "incomplete_graph_profession",
        graphProfessionId: graphProfessionId ?? null,
        title,
      });
      continue;
    }
    if (seenGraphIds.has(graphProfessionId)) {
      blocked.push({
        code: "duplicate_graph_profession",
        graphProfessionId,
        title,
      });
      continue;
    }
    seenGraphIds.add(graphProfessionId);

    if (!industryIds.has(profession.industryId)) {
      blocked.push({
        code: "missing_industry",
        graphProfessionId,
        title,
        industryId: profession.industryId,
      });
      continue;
    }

    const matches = byTitle.get(normalizeTitle(title)) ?? [];
    if (matches.length > 1) {
      blocked.push({
        code: "ambiguous_title",
        graphProfessionId,
        title,
        rowIds: matches.map((row) => row.id),
      });
      continue;
    }

    if (matches.length === 1) {
      const row = matches[0];
      if (
        row.graphProfessionId &&
        row.graphProfessionId !== graphProfessionId
      ) {
        blocked.push({
          code: "graph_id_conflict",
          graphProfessionId,
          title,
          rowId: row.id,
          currentGraphProfessionId: row.graphProfessionId,
        });
        continue;
      }
      if (row.graphProfessionId === graphProfessionId) {
        unchanged.push({
          rowId: row.id,
          graphProfessionId,
          title: row.title,
        });
      } else {
        links.push({
          rowId: row.id,
          graphProfessionId,
          title: row.title,
        });
      }
      continue;
    }

    inserts.push({
      graphProfessionId,
      title,
      description: profession.description ?? null,
      industryExternalId: profession.industryId,
      externalId: externalIds.has(graphProfessionId) ? null : graphProfessionId,
      riasec: profession.riasec ?? null,
    });
    if (!externalIds.has(graphProfessionId)) {
      externalIds.add(graphProfessionId);
    }
  }

  return {
    ok: blocked.length === 0,
    blocked,
    links,
    inserts,
    unchanged,
  };
}

export function applyPlanInMemory(existingProfessions, plan) {
  const rows = existingProfessions.map((row) => ({ ...row }));
  for (const link of plan.links) {
    const row = rows.find((item) => item.id === link.rowId);
    if (!row) {
      throw new Error(`Cannot link missing profession row ${link.rowId}`);
    }
    row.graphProfessionId = link.graphProfessionId;
  }
  for (const insert of plan.inserts) {
    rows.push({
      id: `new:${insert.graphProfessionId}`,
      externalId: insert.externalId,
      title: insert.title,
      graphProfessionId: insert.graphProfessionId,
    });
  }
  return rows;
}

export function assessHybridProfessionState({
  professions,
  graphProfessions,
  legacyProfessions,
}) {
  const problems = [];
  const byGraphId = groupBy(
    professions.filter((row) => row.graphProfessionId),
    (row) => row.graphProfessionId
  );
  if (byGraphId.size !== graphProfessions.length) {
    problems.push({
      code: "graph_id_count",
      expected: graphProfessions.length,
      actual: byGraphId.size,
    });
  }

  for (const profession of graphProfessions) {
    const rows = byGraphId.get(profession.professionId) ?? [];
    if (rows.length !== 1) {
      problems.push({
        code: "graph_id_not_unique",
        graphProfessionId: profession.professionId,
        count: rows.length,
      });
      continue;
    }
    if (normalizeTitle(rows[0].title) !== normalizeTitle(profession.name)) {
      problems.push({
        code: "title_mismatch",
        graphProfessionId: profession.professionId,
        expected: profession.name,
        actual: rows[0].title,
      });
    }
  }

  for (const legacy of legacyProfessions) {
    const matches = professions.filter((row) => row.externalId === legacy.professionId);
    if (matches.length !== 1) {
      problems.push({
        code: "legacy_external_id_missing",
        externalId: legacy.professionId,
        count: matches.length,
      });
      continue;
    }
    if (normalizeTitle(matches[0].title) !== normalizeTitle(legacy.name)) {
      problems.push({
        code: "legacy_title_changed",
        externalId: legacy.professionId,
        expected: legacy.name,
        actual: matches[0].title,
      });
    }
    if (legacy.id && matches[0].id !== legacy.id) {
      problems.push({
        code: "legacy_uuid_changed",
        externalId: legacy.professionId,
        expected: legacy.id,
        actual: matches[0].id,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

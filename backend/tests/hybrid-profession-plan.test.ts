import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPlanInMemory,
  assessHybridProfessionState,
  planHybridProfessionImport,
} from "../scripts/hybrid-profession-plan.mjs";

const industries = [{ externalId: "ind_008" }, { externalId: "ind_015" }];

const existing = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    externalId: "prof_004",
    title: "Сварщик",
    graphProfessionId: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    externalId: "prof_008",
    title: "Инженер-энергетик",
    graphProfessionId: null,
  },
];

const graph = [
  {
    professionId: "prof_004",
    name: "Инженер-энергетик",
    industryId: "ind_008",
    description: "Следит за электричеством.",
    riasec: { R: 0.2 },
  },
  {
    professionId: "prof_027",
    name: "Ветеринарный врач",
    industryId: "ind_015",
    description: "Лечит животных.",
    riasec: null,
  },
];

test("same external id does not link a different profession", () => {
  const plan = planHybridProfessionImport({
    existingProfessions: existing,
    industries,
    graphProfessions: graph,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.links, [
    {
      rowId: "22222222-2222-4222-8222-222222222222",
      graphProfessionId: "prof_004",
      title: "Инженер-энергетик",
    },
  ]);
  assert.equal(
    plan.links.some((link) => link.rowId.startsWith("11111111")),
    false
  );
  assert.equal(existing[0].externalId, "prof_004");
  assert.equal(existing[0].title, "Сварщик");
});

test("new profession is inserted without reusing a taken external id", () => {
  const plan = planHybridProfessionImport({
    existingProfessions: [
      ...existing,
      {
        id: "33333333-3333-4333-8333-333333333333",
        externalId: "prof_029",
        title: "Архитектор",
        graphProfessionId: null,
      },
    ],
    industries,
    graphProfessions: [
      ...graph,
      {
        professionId: "prof_029",
        name: "Журналист / Медиа-специалист",
        industryId: "ind_015",
        description: "Готовит материалы.",
        riasec: null,
      },
    ],
  });

  const inserted = plan.inserts.find(
    (item) => item.graphProfessionId === "prof_029"
  );
  assert.equal(inserted?.externalId, null);
  assert.equal(inserted?.title, "Журналист / Медиа-специалист");
  const veterinarian = plan.inserts.find(
    (item) => item.graphProfessionId === "prof_027"
  );
  assert.equal(veterinarian?.externalId, "prof_027");
});

test("ambiguous and missing industry block the import", () => {
  const ambiguous = planHybridProfessionImport({
    existingProfessions: [
      ...existing,
      {
        id: "44444444-4444-4444-8444-444444444444",
        externalId: "prof_099",
        title: "Инженер-энергетик",
        graphProfessionId: null,
      },
    ],
    industries,
    graphProfessions: [graph[0]],
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.blocked[0].code, "ambiguous_title");
  assert.equal(ambiguous.links.length, 0);

  const missingIndustry = planHybridProfessionImport({
    existingProfessions: existing,
    industries: [],
    graphProfessions: [graph[1]],
  });
  assert.equal(missingIndustry.ok, false);
  assert.equal(missingIndustry.blocked[0].code, "missing_industry");
  assert.equal(missingIndustry.inserts.length, 0);
});

test("planning the same catalog twice does not create more changes", () => {
  const first = planHybridProfessionImport({
    existingProfessions: existing,
    industries,
    graphProfessions: graph,
  });
  const after = applyPlanInMemory(existing, first);
  const second = planHybridProfessionImport({
    existingProfessions: after,
    industries,
    graphProfessions: graph,
  });

  assert.equal(second.ok, true);
  assert.equal(second.links.length, 0);
  assert.equal(second.inserts.length, 0);
  assert.equal(second.unchanged.length, 2);
});

test("state check rejects a replaced legacy uuid and a wrong title", () => {
  const legacy = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      professionId: "prof_008",
      name: "Инженер-энергетик",
    },
  ];
  const rows = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      externalId: "prof_008",
      title: "Инженер-энергетик",
      graphProfessionId: "prof_004",
    },
  ];
  const graphProfessions = [
    { professionId: "prof_004", name: "Инженер-энергетик" },
  ];

  assert.equal(
    assessHybridProfessionState({
      professions: rows,
      graphProfessions,
      legacyProfessions: legacy,
    }).ok,
    true
  );

  const changedUuid = assessHybridProfessionState({
    professions: [{ ...rows[0], id: "99999999-9999-4999-8999-999999999999" }],
    graphProfessions,
    legacyProfessions: legacy,
  });
  assert.equal(changedUuid.ok, false);
  assert.equal(changedUuid.problems[0].code, "legacy_uuid_changed");
});


import ExcelJS from "exceljs";
import path from "node:path";
import pg from "pg";

const apply = process.argv.includes("--apply");

const file = path.resolve(
  "data",
  "Навигатор ЕКБ v1.xlsx"
);

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(file);

// =====================================================
// 1. ОБРАБОТКА ЗНАЧЕНИЙ EXCEL
// =====================================================

function value(v) {
  if (v == null) return null;

  if (v instanceof Date) return v;

  if (typeof v === "object") {
    if ("result" in v) return value(v.result);
    if ("text" in v) return value(v.text);
    return null;
  }

  return v;
}

function text(v) {
  const x = value(v);
  return x == null ? "" : String(x).trim();
}

function nullable(v) {
  return text(v) || null;
}

function number(v) {
  const x = value(v);

  if (x == null || x === "") return null;

  if (x instanceof Date) {
    throw new Error(
      `Expected number, got Excel date: ${x.toISOString()}`
    );
  }

  const n = Number(String(x).replace(",", "."));

  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number: ${String(x)}`);
  }

  return n;
}

function integer(v) {
  const n = number(v);

  if (n != null && !Number.isInteger(n)) {
    throw new Error(`Not an integer: ${n}`);
  }

  return n;
}

// Исправление: даты вместо продолжительности обучения
function durationYears(v, programId) {
  const x = value(v);

  if (x == null || x === "") return null;

  if (x instanceof Date) {
    console.warn(
      `WARNING: ${programId}: duration_years ` +
      `contains Excel date, using NULL`
    );
    return null;
  }

  const n = number(v);

  if (n != null && (n <= 0 || n > 20)) {
    console.warn(
      `WARNING: ${programId}: suspicious duration_years ` +
      `(${n}), using NULL`
    );
    return null;
  }

  return n;
}

// Исправление: Excel испортил коды специальностей
function specialty(v, programId, warnings) {
  const x = value(v);

  if (x == null || x === "") return null;

  if (x instanceof Date || typeof x === "number") {
    warnings.push(
      `${programId}: ambiguous specialty_code`
    );
    return null;
  }

  const s = text(v);

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    warnings.push(
      `${programId}: date-like specialty_code`
    );
    return null;
  }

  return s || null;
}

// Даты снимков вакансий
function date(v) {
  const x = value(v);

  if (x instanceof Date) {
    return x.toISOString().slice(0, 10);
  }

  if (
    typeof x === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(x)
  ) {
    return x;
  }

  throw new Error(
    `Invalid vacancy snapshot date: ${String(x)}`
  );
}

// =====================================================
// 2. ЧТЕНИЕ ЛИСТОВ EXCEL
// =====================================================

function sheetRows(name) {
  const sheet = workbook.getWorksheet(name);

  if (!sheet) {
    throw new Error(`Missing worksheet: ${name}`);
  }

  const headers = sheet
    .getRow(1)
    .values
    .slice(1)
    .map(text);

  const rows = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const record = Object.fromEntries(
      headers.map((header, index) => [
        header,
        value(row.getCell(index + 1).value)
      ])
    );

    const hasData = Object.values(record).some(
      v => v !== null && v !== undefined && v !== ""
    );

    if (hasData) {
      rows.push(record);
    }
  });

  return rows;
}

const names = [
  "industry",
  "profession",
  "skill",
  "profession_skill",
  "organization",
  "education_program",
  "program_profession",
  "trial",
  "trial_profession",
  "vacancy_snapshot"
];

const data = Object.fromEntries(
  names.map(name => [
    name,
    sheetRows(name)
  ])
);

// =====================================================
// 3. ПРОВЕРКА ID И СВЯЗЕЙ
// =====================================================

const problems = [];
const specialtyWarnings = [];

function ids(sheetName, column) {
  const result = new Set();

  for (const row of data[sheetName]) {
    const id = text(row[column]);

    if (!id) {
      problems.push(
        `${sheetName}: empty ${column}`
      );
    } else if (result.has(id)) {
      problems.push(
        `${sheetName}: duplicate ID ${id}`
      );
    }

    result.add(id);
  }

  return result;
}

const valid = {
  industry: ids("industry", "industry_id"),
  profession: ids("profession", "profession_id"),
  skill: ids("skill", "skill_id"),
  organization: ids("organization", "organization_id"),
  program: ids("education_program", "program_id"),
  trial: ids("trial", "trial_id")
};

const references = [
  ["profession", "industry_id", "industry"],
  ["profession_skill", "profession_id", "profession"],
  ["profession_skill", "skill_id", "skill"],
  ["education_program", "organization_id", "organization"],
  ["program_profession", "program_id", "program"],
  ["program_profession", "profession_id", "profession"],
  ["trial", "organization_id", "organization"],
  ["trial_profession", "trial_id", "trial"],
  ["trial_profession", "profession_id", "profession"],
  ["vacancy_snapshot", "profession_id", "profession"]
];

for (const [sheetName, column, target] of references) {
  for (const row of data[sheetName]) {
    const id = text(row[column]);

    if (!valid[target].has(id)) {
      problems.push(
        `${sheetName}: unknown ${column}: ${id}`
      );
    }
  }
}

// Проверяем специальности и продолжительность
for (const row of data.education_program) {
  specialty(
    row.specialty_code,
    text(row.program_id),
    specialtyWarnings
  );

  durationYears(
    row.duration_years,
    text(row.program_id)
  );
}

// Проверяем возрастные ограничения проб
for (const row of data.trial) {
  const lo = integer(row.age_min);
  const hi = integer(row.age_max);

  if (lo != null && hi != null && lo > hi) {
    problems.push(
      `trial ${text(row.trial_id)}: age_min > age_max`
    );
  }

  if (lo != null && (lo < 8 || lo > 25)) {
    problems.push(
      `trial ${text(row.trial_id)}: invalid age_min`
    );
  }

  if (hi != null && (hi < 8 || hi > 25)) {
    problems.push(
      `trial ${text(row.trial_id)}: invalid age_max`
    );
  }
}

console.log("\n=== CATALOG VALIDATION ===");

for (const name of names) {
  console.log(`${name}: ${data[name].length}`);
}

console.log(
  `Invalid references / IDs: ${problems.length}`
);

console.log(
  `Ambiguous specialty codes: ${specialtyWarnings.length}`
);

for (const warning of specialtyWarnings) {
  console.warn("WARNING:", warning);
}

for (const problem of problems) {
  console.error("ERROR:", problem);
}

if (problems.length > 0) {
  console.error("\nValidation failed. Import cancelled.");
  process.exit(1);
}

if (!apply) {
  console.log(
    "\nVALIDATION ONLY. No database changes."
  );

  process.exit(0);
}

// =====================================================
// 4. ПОДКЛЮЧЕНИЕ К POSTGRESQL
// =====================================================

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set");
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

const client = await pool.connect();

const map = {
  industry: new Map(),
  profession: new Map(),
  skill: new Map(),
  organization: new Map(),
  program: new Map(),
  trial: new Map()
};

function get(which, externalId) {
  const id = map[which].get(text(externalId));

  if (!id) {
    throw new Error(
      `Missing UUID for ${which}: ${text(externalId)}`
    );
  }

  return id;
}

async function upsert(sql, params) {
  const result = await client.query(sql, params);

  if (!result.rows[0]) {
    throw new Error("UPSERT returned no rows");
  }

  return result.rows[0].id;
}

// =====================================================
// 5. ИМПОРТ В ОДНОЙ ТРАНЗАКЦИИ
// =====================================================

try {
  await client.query("BEGIN");

  await client.query(
    "SELECT pg_advisory_xact_lock(91826022)"
  );

  // Регион
  const regionResult = await client.query(`
    INSERT INTO regions(name)
    VALUES ('Екатеринбург')
    ON CONFLICT(name)
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);

  const regionId = regionResult.rows[0].id;

  // -------------------------------------------------
  // ОТРАСЛИ
  // -------------------------------------------------

  for (const row of data.industry) {
    const id = await upsert(`
      INSERT INTO industries(
        external_id,
        name,
        description_kid,
        regional_importance
      )
      VALUES ($1,$2,$3,$4)
      ON CONFLICT(external_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        description_kid = EXCLUDED.description_kid,
        regional_importance = EXCLUDED.regional_importance
      RETURNING id
    `, [
      text(row.industry_id),
      text(row.name),
      nullable(row.description_kid),
      nullable(row.regional_importance)
    ]);

    map.industry.set(text(row.industry_id), id);
  }

  // -------------------------------------------------
  // ПРОФЕССИИ
  // -------------------------------------------------

  for (const row of data.profession) {
    const riasec = Object.fromEntries(
      "RIASEC".split("").map(letter => [
        letter,
        number(row[`riasec_${letter}`])
      ])
    );

    const id = await upsert(`
      INSERT INTO professions(
        external_id,
        title,
        description,
        industry_id,
        riasec,
        demand_level_region,
        salary_median_region,
        vacancies_count
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
      ON CONFLICT(external_id)
      DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        industry_id = EXCLUDED.industry_id,
        riasec = EXCLUDED.riasec,
        demand_level_region = EXCLUDED.demand_level_region,
        salary_median_region = EXCLUDED.salary_median_region,
        vacancies_count = EXCLUDED.vacancies_count
      RETURNING id
    `, [
      text(row.profession_id),
      text(row.name),
      nullable(row.what_does_kid),
      get("industry", row.industry_id),
      JSON.stringify(riasec),
      nullable(row.demand_level_region),
      number(row.salary_median_region),
      integer(row.vacancies_count)
    ]);

    map.profession.set(text(row.profession_id), id);
  }

  // -------------------------------------------------
  // НАВЫКИ
  // -------------------------------------------------

  for (const row of data.skill) {
    const id = await upsert(`
      INSERT INTO skills(
        external_id,
        name,
        type,
        description_kid
      )
      VALUES ($1,$2,$3,$4)
      ON CONFLICT(external_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        description_kid = EXCLUDED.description_kid
      RETURNING id
    `, [
      text(row.skill_id),
      text(row.name),
      nullable(row.type),
      nullable(row.description_kid)
    ]);

    map.skill.set(text(row.skill_id), id);
  }

  // -------------------------------------------------
  // СВЯЗИ ПРОФЕССИЙ И НАВЫКОВ
  // -------------------------------------------------

  for (const row of data.profession_skill) {
    await client.query(`
      INSERT INTO profession_skills(
        profession_id,
        skill_id,
        importance
      )
      VALUES ($1,$2,$3)
      ON CONFLICT(profession_id,skill_id)
      DO UPDATE SET
        importance = EXCLUDED.importance
    `, [
      get("profession", row.profession_id),
      get("skill", row.skill_id),
      integer(row.importance)
    ]);
  }

  // -------------------------------------------------
  // ОРГАНИЗАЦИИ
  // -------------------------------------------------

  for (const row of data.organization) {
    const municipality = text(row.municipality);

    const id = await upsert(`
      INSERT INTO organizations(
        external_id,
        name,
        organization_type,
        municipality,
        address,
        website,
        region_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(external_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        organization_type = EXCLUDED.organization_type,
        municipality = EXCLUDED.municipality,
        address = EXCLUDED.address,
        website = EXCLUDED.website,
        region_id = EXCLUDED.region_id
      RETURNING id
    `, [
      text(row.organization_id),
      text(row.name),
      nullable(row.org_type),
      nullable(row.municipality),
      nullable(row.address),
      nullable(row.website),
      municipality === "Екатеринбург"
        ? regionId
        : null
    ]);

    map.organization.set(
      text(row.organization_id),
      id
    );
  }

  // -------------------------------------------------
  // ОБРАЗОВАТЕЛЬНЫЕ ПРОГРАММЫ
  // -------------------------------------------------

  for (const row of data.education_program) {
    const organization = data.organization.find(
      item =>
        text(item.organization_id) ===
        text(row.organization_id)
    );

    const code = specialty(
      row.specialty_code,
      row.program_id,
      []
    );

    const duration = durationYears(
      row.duration_years,
      text(row.program_id)
    );

    const id = await upsert(`
      INSERT INTO education_programs(
        external_id,
        title,
        institution,
        organization_id,
        level,
        specialty_code,
        duration_years,
        region_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(external_id)
      DO UPDATE SET
        title = EXCLUDED.title,
        institution = EXCLUDED.institution,
        organization_id = EXCLUDED.organization_id,
        level = EXCLUDED.level,
        specialty_code = EXCLUDED.specialty_code,
        duration_years = EXCLUDED.duration_years,
        region_id = EXCLUDED.region_id
      RETURNING id
    `, [
      text(row.program_id),
      text(row.name),
      organization
        ? text(organization.name)
        : "Неизвестная организация",
      get("organization", row.organization_id),
      nullable(row.level),
      code,
      duration,
      regionId
    ]);

    map.program.set(text(row.program_id), id);
  }

  // -------------------------------------------------
  // СВЯЗИ ПРОГРАММ И ПРОФЕССИЙ
  // -------------------------------------------------

  for (const row of data.program_profession) {
    await client.query(`
      INSERT INTO program_professions(
        program_id,
        profession_id,
        fit_level
      )
      VALUES ($1,$2,$3)
      ON CONFLICT(program_id,profession_id)
      DO UPDATE SET
        fit_level = EXCLUDED.fit_level
    `, [
      get("program", row.program_id),
      get("profession", row.profession_id),
      nullable(row.fit_level)
    ]);
  }

  // -------------------------------------------------
  // ПРОФЕССИОНАЛЬНЫЕ ПРОБЫ
  // -------------------------------------------------

  for (const row of data.trial) {
    const municipality = text(row.municipality);

    const id = await upsert(`
      INSERT INTO professional_trials(
        external_id,
        title,
        description,
        format,
        duration_minutes,
        age_min,
        age_max,
        organization_id,
        region_id,
        municipality,
        cost,
        source_url
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      )
      ON CONFLICT(external_id)
      DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        format = EXCLUDED.format,
        duration_minutes = EXCLUDED.duration_minutes,
        age_min = EXCLUDED.age_min,
        age_max = EXCLUDED.age_max,
        organization_id = EXCLUDED.organization_id,
        region_id = EXCLUDED.region_id,
        municipality = EXCLUDED.municipality,
        cost = EXCLUDED.cost,
        source_url = EXCLUDED.source_url
      RETURNING id
    `, [
      text(row.trial_id),
      text(row.title),
      nullable(row.description_kid),
      nullable(row.format),
      integer(row.duration_minutes),
      integer(row.age_min),
      integer(row.age_max),
      get("organization", row.organization_id),
      municipality === "Екатеринбург"
        ? regionId
        : null,
      nullable(row.municipality),
      nullable(row.cost),
      nullable(row.source_url)
    ]);

    map.trial.set(text(row.trial_id), id);
  }

  // -------------------------------------------------
  // СВЯЗИ ПРОБ И ПРОФЕССИЙ
  // -------------------------------------------------

  for (const row of data.trial_profession) {
    await client.query(`
      INSERT INTO trial_professions(
        trial_id,
        profession_id,
        skills_checked
      )
      VALUES ($1,$2,$3)
      ON CONFLICT(trial_id,profession_id)
      DO UPDATE SET
        skills_checked = EXCLUDED.skills_checked
    `, [
      get("trial", row.trial_id),
      get("profession", row.profession_id),
      nullable(row.skills_checked)
    ]);
  }

  // -------------------------------------------------
  // СНИМКИ ВАКАНСИЙ
  // -------------------------------------------------

  for (const row of data.vacancy_snapshot) {
    const professionId = get(
      "profession",
      row.profession_id
    );

    const snapshotDate = date(row.date);

    const sourceExternalId = nullable(
      row.source_id
    );

    await client.query(`
      INSERT INTO vacancy_snapshots(
        profession_id,
        snapshot_date,
        vacancies_count,
        salary_median,
        source_external_id
      )
      SELECT $1,$2,$3,$4,$5
      WHERE NOT EXISTS (
        SELECT 1
        FROM vacancy_snapshots
        WHERE profession_id = $1
          AND snapshot_date = $2
          AND source_external_id
            IS NOT DISTINCT FROM $5
      )
    `, [
      professionId,
      snapshotDate,
      integer(row.vacancies_count),
      number(row.salary_median),
      sourceExternalId
    ]);
  }

  // -------------------------------------------------
  // СОХРАНЯЕМ ТРАНЗАКЦИЮ
  // -------------------------------------------------

  await client.query("COMMIT");

  console.log("\n=================================");
  console.log("SUCCESS. Catalog imported.");
  console.log("=================================");

  console.log(
    `Industries: ${data.industry.length}`
  );

  console.log(
    `Professions: ${data.profession.length}`
  );

  console.log(
    `Skills: ${data.skill.length}`
  );

  console.log(
    `Organizations: ${data.organization.length}`
  );

  console.log(
    `Programs: ${data.education_program.length}`
  );

  console.log(
    `Trials: ${data.trial.length}`
  );

  console.log(
    `Vacancy snapshots processed: ${data.vacancy_snapshot.length}`
  );

} catch (error) {
  await client.query("ROLLBACK");

  console.error(
    "\nIMPORT FAILED. Transaction rolled back:"
  );

  console.error(error.message);

  process.exitCode = 1;

} finally {
  client.release();
  await pool.end();
}

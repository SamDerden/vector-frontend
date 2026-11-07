
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  _request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;

    // 1. Основная информация о профессии
    // Поддерживаем внешний ID Алисы (prof_001)
    // и внутренний UUID PostgreSQL.

    const professionResult = await query(
      `
      SELECT
        p.id,
        p.external_id,
        p.title,
        p.description,
        i.name AS industry_name,
        p.riasec,
        p.demand_level_region,
        p.salary_median_region,
        p.vacancies_count
      FROM professions p
      LEFT JOIN industries i
        ON p.industry_id = i.id
      WHERE
        p.external_id = $1
        OR p.id::text = $1
      LIMIT 1
      `,
      [id]
    );

    if (professionResult.rows.length === 0) {
      return NextResponse.json(
        { error: "Profession not found" },
        { status: 404 }
      );
    }

    const profession = professionResult.rows[0];
    const professionId = profession.id;

    // 2. Навыки профессии

    const skillsResult = await query(
      `
      SELECT
        s.external_id AS skill_id,
        s.name,
        s.type,
        s.description_kid,
        ps.importance
      FROM profession_skills ps
      JOIN skills s
        ON ps.skill_id = s.id
      WHERE ps.profession_id = $1
      ORDER BY
        ps.importance DESC NULLS LAST,
        s.name ASC
      `,
      [professionId]
    );

    // 3. Образовательные программы

    const programsResult = await query(
      `
      SELECT
        ep.external_id AS program_id,
        ep.title,
        ep.institution,
        ep.level,
        ep.specialty_code,
        ep.duration_years,
        o.name AS organization_name,
        pp.fit_level
      FROM program_professions pp
      JOIN education_programs ep
        ON pp.program_id = ep.id
      LEFT JOIN organizations o
        ON ep.organization_id = o.id
      WHERE pp.profession_id = $1
      ORDER BY ep.title ASC
      `,
      [professionId]
    );

    // 4. Профессиональные пробы

    const trialsResult = await query(
      `
      SELECT
        pt.external_id AS trial_id,
        pt.title,
        pt.description,
        pt.format,
        pt.duration_minutes,
        pt.age_min,
        pt.age_max,
        pt.municipality,
        pt.cost,
        pt.source_url,
        o.name AS organization_name,
        tp.skills_checked
      FROM trial_professions tp
      JOIN professional_trials pt
        ON tp.trial_id = pt.id
      LEFT JOIN organizations o
        ON pt.organization_id = o.id
      WHERE tp.profession_id = $1
        AND pt.is_active = TRUE
      ORDER BY pt.title ASC
      `,
      [professionId]
    );

    // 5. История вакансий

    const vacanciesResult = await query(
      `
      SELECT
        snapshot_date,
        vacancies_count,
        salary_median,
        source_external_id
      FROM vacancy_snapshots
      WHERE profession_id = $1
      ORDER BY snapshot_date DESC
      `,
      [professionId]
    );

    // 6. Формируем единую карточку

    return NextResponse.json({
      data: {
        ...profession,
        skills: skillsResult.rows,
        education_programs: programsResult.rows,
        trials: trialsResult.rows,
        vacancy_history: vacanciesResult.rows
      }
    });

  } catch (error) {
    console.error(
      "Failed to fetch profession details:",
      error
    );

    return NextResponse.json(
      { error: "Failed to fetch profession details" },
      { status: 500 }
    );
  }
}

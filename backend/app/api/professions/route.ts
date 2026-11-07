
import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await query(`
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
      WHERE p.is_active = TRUE
      ORDER BY p.title ASC
    `);

    return NextResponse.json({
      data: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    console.error(
      "Failed to fetch professions:",
      error
    );

    return NextResponse.json(
      {
        error: "Failed to fetch professions"
      },
      {
        status: 500
      }
    );
  }
}

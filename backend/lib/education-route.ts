import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAVED_ID = /^(?:program:prog_\d{3,4}|program:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|prog_\d{3,4}|trial_\d{3,4}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export const professionKeySchema = z.union([z.literal("none"), z.string().regex(UUID)]);

export const educationRouteSchema = z.object({
  professionKey: professionKeySchema,
  completed: z.array(z.number().int().min(0).max(4)).max(5),
  saved: z.array(z.string().regex(SAVED_ID)).max(40),
  version: z.number().int().min(1).max(1_000_000).nullable(),
}).strict().superRefine((route, ctx) => {
  if (new Set(route.completed).size !== route.completed.length) {
    ctx.addIssue({ code: "custom", path: ["completed"], message: "Duplicate route stage" });
  }
  if (new Set(route.saved.map((item) => item.toLowerCase())).size !== route.saved.length) {
    ctx.addIssue({ code: "custom", path: ["saved"], message: "Duplicate saved id" });
  }
});

export type EducationRouteInput = z.infer<typeof educationRouteSchema>;

export const READ_EDUCATION_ROUTE_SQL = `SELECT profession_key, completed, saved_ids, version, updated_at
FROM education_routes
WHERE session_id = $1 AND profession_key = $2`;

export const UPSERT_EDUCATION_ROUTE_SQL = `WITH locked AS (
  SELECT id, version
  FROM education_routes
  WHERE session_id = $1 AND profession_key = $2
  FOR UPDATE
),
updated AS (
  UPDATE education_routes AS route
  SET completed = $3::smallint[],
      saved_ids = $4::text[],
      version = route.version + 1,
      updated_at = now()
  FROM locked
  WHERE route.id = locked.id
    AND locked.version = $5::int
  RETURNING route.profession_key, route.completed, route.saved_ids, route.version, route.updated_at
),
inserted AS (
  INSERT INTO education_routes (session_id, profession_key, completed, saved_ids)
  SELECT $1, $2, $3::smallint[], $4::text[]
  WHERE NOT EXISTS (SELECT 1 FROM locked)
    AND $5::int IS NULL
  ON CONFLICT (session_id, profession_key) DO NOTHING
  RETURNING profession_key, completed, saved_ids, version, updated_at
)
SELECT * FROM updated
UNION ALL
SELECT * FROM inserted`;

type DbQuery = (
  sql: string,
  params?: unknown[]
) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;

export type StoredEducationRoute = {
  professionKey: string;
  completed: number[];
  saved: string[];
  version: number;
  updatedAt: string;
};

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isInteger(item));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

export function mapEducationRoute(row: Record<string, unknown>): StoredEducationRoute | null {
  const professionKey = typeof row.profession_key === "string" ? row.profession_key : "";
  const version = Number(row.version);
  const updatedAt = row.updated_at instanceof Date
    ? row.updated_at.toISOString()
    : typeof row.updated_at === "string"
      ? row.updated_at
      : "";
  if ((!UUID.test(professionKey) && professionKey !== "none") || !Number.isInteger(version) || version < 1 || !updatedAt) {
    return null;
  }
  return {
    professionKey,
    completed: numberList(row.completed),
    saved: stringList(row.saved_ids),
    version,
    updatedAt,
  };
}

export async function readEducationRoute(
  query: DbQuery,
  sessionId: string,
  professionKey: string
): Promise<StoredEducationRoute | null> {
  const found = await query(READ_EDUCATION_ROUTE_SQL, [sessionId, professionKey]);
  return found.rows[0] ? mapEducationRoute(found.rows[0]) : null;
}

export async function saveEducationRoute(
  query: DbQuery,
  sessionId: string,
  input: EducationRouteInput
): Promise<{ status: 200 | 201 | 404 | 409; route: StoredEducationRoute | null }> {
  const saved = await query(UPSERT_EDUCATION_ROUTE_SQL, [
    sessionId,
    input.professionKey,
    input.completed,
    input.saved,
    input.version,
  ]);
  const written = saved.rows[0] ? mapEducationRoute(saved.rows[0]) : null;
  if (written) return { status: input.version == null ? 201 : 200, route: written };
  const current = await readEducationRoute(query, sessionId, input.professionKey);
  return { status: current ? 409 : 404, route: current };
}

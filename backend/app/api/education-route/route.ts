import { NextRequest, NextResponse } from "next/server";

import { isMissingSchemaError, query } from "@/lib/db";
import {
  educationRouteSchema,
  professionKeySchema,
  readEducationRoute,
  saveEducationRoute,
} from "@/lib/education-route";
import { handleError, jsonError } from "@/lib/http";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function outdatedSchema(error: unknown): boolean {
  if (isMissingSchemaError(error)) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code: unknown }).code);
  return code === "42P01" || code === "42703";
}

function professionKeyFrom(request: NextRequest): string | null {
  const withUrl = request as NextRequest & { nextUrl?: { searchParams: URLSearchParams }; url?: string };
  if (withUrl.nextUrl) return withUrl.nextUrl.searchParams.get("professionKey");
  if (withUrl.url) return new URL(withUrl.url).searchParams.get("professionKey");
  return null;
}

function publicRoute(route: {
  professionKey: string;
  completed: number[];
  saved: string[];
  version: number;
  updatedAt: string;
}) {
  return {
    professionKey: route.professionKey,
    completed: route.completed,
    saved: route.saved,
    version: route.version,
    updatedAt: route.updatedAt,
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) return session.error;
    const parsed = professionKeySchema.safeParse(professionKeyFrom(request) ?? "");
    if (!parsed.success) return handleError(parsed.error);
    const route = await readEducationRoute(query, session.sessionId, parsed.data);
    if (!route) return jsonError("Education route not found", 404);
    return NextResponse.json(publicRoute(route));
  } catch (error) {
    if (outdatedSchema(error)) return jsonError("Database schema is outdated. Run npm run db:migrate", 503);
    return handleError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) return session.error;
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) return jsonError("Request body must be valid JSON");
      throw error;
    }
    const parsed = educationRouteSchema.safeParse(body);
    if (!parsed.success) return handleError(parsed.error);
    const saved = await saveEducationRoute(query, session.sessionId, parsed.data);
    if (saved.status === 404 || !saved.route) return jsonError("Education route not found", 404);
    if (saved.status === 409) {
      return jsonError("Education route version conflict", 409, { route: publicRoute(saved.route) });
    }
    return NextResponse.json(publicRoute(saved.route), { status: saved.status });
  } catch (error) {
    if (outdatedSchema(error)) return jsonError("Database schema is outdated. Run npm run db:migrate", 503);
    return handleError(error);
  }
}

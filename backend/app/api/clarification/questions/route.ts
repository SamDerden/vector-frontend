import { NextRequest, NextResponse } from "next/server";

import { getClarificationQuestions, getPrimaryClarificationQuestions } from "@/lib/catalog-data";
import { handleError, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const rawGrade = request.nextUrl.searchParams.get("grade");
    if (rawGrade !== null && (!/^(?:[1-9]|10|11)$/.test(rawGrade))) {
      return jsonError("grade must be an integer between 1 and 11", 400);
    }
    const grade = rawGrade === null ? null : Number(rawGrade);
    const questions = grade !== null && grade <= 4
      ? getPrimaryClarificationQuestions()
      : getClarificationQuestions();
    return NextResponse.json({ data: questions, count: questions.length });
  } catch (error) {
    return handleError(error);
  }
}

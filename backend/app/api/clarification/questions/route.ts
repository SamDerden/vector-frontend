import { NextResponse } from "next/server";

import { getClarificationQuestions } from "@/lib/catalog-data";
import { handleError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const questions = getClarificationQuestions();
    return NextResponse.json({
      data: questions,
      count: questions.length,
    });
  } catch (error) {
    return handleError(error);
  }
}

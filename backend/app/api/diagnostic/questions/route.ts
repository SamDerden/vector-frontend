import { NextRequest, NextResponse } from "next/server";

import { getBiletQuestionnaires, questionnaireForGrade } from "@/lib/catalog-data";
import { jsonError, handleError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const gradeParam = request.nextUrl.searchParams.get("grade");

    if (gradeParam != null) {
      const grade = Number(gradeParam);
      if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
        return jsonError("grade must be an integer between 1 and 11", 400);
      }

      const questionnaire = questionnaireForGrade(grade);
      if (!questionnaire) {
        return jsonError("Questionnaire for this grade is not available", 404);
      }

      return NextResponse.json({
        grade,
        questionnaire,
      });
    }

    const questionnaires = getBiletQuestionnaires();
    return NextResponse.json({
      data: questionnaires.map((item) => ({
        questionnaire_name: item.questionnaire_name,
        note: item.note ?? null,
        questionCount: item.blocks.reduce(
          (sum, block) => sum + block.questions.length,
          0
        ),
      })),
      count: questionnaires.length,
    });
  } catch (error) {
    return handleError(error);
  }
}

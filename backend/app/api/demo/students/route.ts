import {NextResponse} from "next/server";
import {getMockStudents,lookupQuestionText} from "@/lib/catalog-data";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(){
 const students=getMockStudents().map(s=>({
  studentId:s.student_id,grade:s.grade,city:s.city,questionnaireName:s.questionnaire_name,
  answers:Object.entries(s.answers).map(([questionId,answer])=>({questionId,answer,question:lookupQuestionText(questionId)||questionId}))
 }));
 return NextResponse.json({data:students,count:students.length},{headers:{"Cache-Control":"no-store"}});
}

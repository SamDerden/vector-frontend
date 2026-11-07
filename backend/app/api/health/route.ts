import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function aiConfigured() {
  return Boolean(
    process.env.AI_API_BASE_URL && process.env.AI_API_KEY && process.env.AI_MODEL
  );
}

export async function GET() {
  try {
    await query("SELECT 1");
    return NextResponse.json({
      status: "ok",
      database: "connected",
      service: "professional-navigator-api",
      aiConfigured: aiConfigured(),
    });
  } catch {
    return NextResponse.json(
      {
        status: "error",
        database: "disconnected",
        service: "professional-navigator-api",
        aiConfigured: aiConfigured(),
      },
      { status: 503 }
    );
  }
}

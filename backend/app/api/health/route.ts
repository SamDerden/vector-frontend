import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { sessionProofEnforced } from "@/lib/session";
import { logEvent } from "@/lib/observe";

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
      readiness: {
        sessionProofEnforced: sessionProofEnforced(),
        embeddingsConfigured: Boolean(process.env.LLM_EMBEDDINGS_MODEL),
        generationWorker: "external-process",
        rateLimit: "per-process",
      },
    });
  } catch (error) {
    logEvent("health_database_unavailable", { name: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json(
      {
        status: "error",
        database: "disconnected",
        service: "professional-navigator-api",
        aiConfigured: aiConfigured(),
        readiness: {
          sessionProofEnforced: sessionProofEnforced(),
          embeddingsConfigured: Boolean(process.env.LLM_EMBEDDINGS_MODEL),
          generationWorker: "external-process",
          rateLimit: "per-process",
        },
      },
      { status: 503 }
    );
  }
}

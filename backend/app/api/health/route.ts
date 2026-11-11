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
      revision: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      sessionOwnership: process.env.NODE_ENV === "production" || process.env.SESSION_PROOF_ENFORCED === "true",
      generationWorker: process.env.GENERATION_WORKER_ENABLED === "true",
      database: "connected",
      service: "professional-navigator-api",
      aiConfigured: aiConfigured(),
      readiness: {
        sessionProofEnforced: sessionProofEnforced(),
        embeddingsConfigured: Boolean(process.env.LLM_EMBEDDINGS_MODEL),
        generationWorker: "external-process",
        rateLimit: "database-budgets-and-per-process",
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
          rateLimit: "database-budgets-and-per-process",
        },
      },
      { status: 503 }
    );
  }
}

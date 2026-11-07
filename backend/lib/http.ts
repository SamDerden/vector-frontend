import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function jsonError(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ error: message, ...(details ? { details } : {}) }, { status });
}
export function handleError(error: unknown) {
  if (error instanceof ZodError) {
    return jsonError("Validation failed", 422, error.issues);
  }
  console.error("API error:", error);
  return jsonError("Internal server error", 500);
}

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { errorName, logEvent } from "./observe.ts";

export function jsonError(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ error: message, ...(details ? { details } : {}) }, { status });
}

export function rateLimited(retryAfterMs: number) {
  return jsonError("Too many requests. Retry later.", 429, {
    code: "rate_limited",
    retryAfterMs,
  });
}

export function handleError(error: unknown) {
  if (error instanceof ZodError) {
    return jsonError("Validation failed", 422, error.issues);
  }
  logEvent("api_error", { name: errorName(error) });
  return jsonError("Internal server error", 500);
}

import { createHash } from "node:crypto";

import { createRateLimiter, type RateDecision } from "./rate-limit.ts";

export type AbuseLimits = {
  generation: number;
  generationWindowMs: number;
  writes: number;
  writesWindowMs: number;
  reads: number;
  readsWindowMs: number;
  trackPerIp: number;
  trackWindowMs: number;
};

export type AbuseGuard = {
  limits: AbuseLimits;
  disabled: boolean;
  guardGeneration(sessionId: string, requestId: string): Promise<RateDecision>;
  guardWrite(sessionId: string): Promise<RateDecision>;
  guardRead(sessionId: string): Promise<RateDecision>;
  guardTrackCreate(clientKey: string): Promise<RateDecision>;
};

const TEN_MINUTES = 10 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;

export const SCHOOL_SAFE_LIMITS: AbuseLimits = {
  generation: 12,
  generationWindowMs: THIRTY_MINUTES,
  writes: 60,
  writesWindowMs: 60 * 1000,
  reads: 240,
  readsWindowMs: 60 * 1000,
  trackPerIp: 180,
  trackWindowMs: TEN_MINUTES,
};

function positive(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) return fallback;
  return parsed;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): AbuseLimits {
  return {
    generation: positive(env.RATE_LIMIT_GENERATION, SCHOOL_SAFE_LIMITS.generation),
    generationWindowMs: SCHOOL_SAFE_LIMITS.generationWindowMs,
    writes: positive(env.RATE_LIMIT_WRITES, SCHOOL_SAFE_LIMITS.writes),
    writesWindowMs: SCHOOL_SAFE_LIMITS.writesWindowMs,
    reads: positive(env.RATE_LIMIT_READS, SCHOOL_SAFE_LIMITS.reads),
    readsWindowMs: SCHOOL_SAFE_LIMITS.readsWindowMs,
    trackPerIp: positive(env.RATE_LIMIT_TRACK_IP, SCHOOL_SAFE_LIMITS.trackPerIp),
    trackWindowMs: SCHOOL_SAFE_LIMITS.trackWindowMs,
  };
}

export function createAbuseGuard(
  limits: AbuseLimits = limitsFromEnv(),
  disabled = process.env.RATE_LIMIT_DISABLED === "true"
): AbuseGuard {
  const generation = createRateLimiter(limits.generation, limits.generationWindowMs);
  const writes = createRateLimiter(limits.writes, limits.writesWindowMs);
  const reads = createRateLimiter(limits.reads, limits.readsWindowMs);
  const tracks = createRateLimiter(limits.trackPerIp, limits.trackWindowMs);
  const allow = async (): Promise<RateDecision> => ({ ok: true });
  if (disabled) {
    return {
      limits,
      disabled: true,
      guardGeneration: allow,
      guardWrite: allow,
      guardRead: allow,
      guardTrackCreate: allow,
    };
  }
  return {
    limits,
    disabled: false,
    guardGeneration: (sessionId, requestId) => generation.remember(`gen:${sessionId}`, requestId),
    guardWrite: (sessionId) => writes.take(`write:${sessionId}`),
    guardRead: (sessionId) => reads.take(`read:${sessionId}`),
    guardTrackCreate: (clientKey) => tracks.take(`track:${clientKey}`),
  };
}

export const abuseGuard = createAbuseGuard();

export function clientKeyFromHeaders(headers: { get(name: string): string | null } | undefined): string {
  const forwarded = headers?.get("x-forwarded-for") ?? headers?.get("X-Forwarded-For") ?? "";
  const first = forwarded.split(",")[0]?.trim() ?? "";
  const raw = first || headers?.get("x-real-ip") || "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

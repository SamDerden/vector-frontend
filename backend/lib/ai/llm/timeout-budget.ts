/** Bound each HTTP attempt by both the configured limit and the remaining generation deadline. */
export function boundedAttemptTimeoutMs(
  requestedMs: number,
  configuredMs: number,
  remainingMs: number
): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new RangeError("deadline exceeded");
  const perAttempt = requestedMs > 0 && Number.isFinite(requestedMs) ? requestedMs : configuredMs;
  return Math.max(1, Math.min(perAttempt, configuredMs, remainingMs));
}

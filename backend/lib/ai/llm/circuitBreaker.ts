// lib/ai/llm/circuitBreaker.ts
import llmConfig from "@/config/llm.config.json";

let failureCount = 0;
let blockedUntil: number | null = null;

export function isCircuitOpen(): boolean {
  if (blockedUntil === null) return false;
  if (Date.now() > blockedUntil) {
    // Время блокировки прошло — сбрасываем
    blockedUntil = null;
    failureCount = 0;
    return false;
  }
  return true;
}

export function recordSuccess() {
  failureCount = 0;
  blockedUntil = null;
}

export function recordFailure() {
  failureCount++;
  if (failureCount >= llmConfig.circuit_breaker.failure_threshold) {
    blockedUntil = Date.now() + llmConfig.circuit_breaker.cooldown_ms;
    console.warn(`[CircuitBreaker] Разомкнут на ${llmConfig.circuit_breaker.cooldown_ms}мс после ${failureCount} сбоев.`);
  }
}

export function resetCircuitBreaker() {
  failureCount = 0;
  blockedUntil = null;
}
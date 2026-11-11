// lib/ai/cache.ts
import { createHash } from "node:crypto";

interface CacheEntry {
  data: unknown;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // One hour; never reuse an unbounded fallback.

/**
 * Генерирует ключ кэша на основе ответов, версий промта, каталога и конфига.
 */
export function makeCacheKey(
  answers: unknown[],
  promptVersion: string,
  catalogVersion: string,
  configVersion: string
): string {
  const raw = JSON.stringify({ answers, promptVersion, catalogVersion, configVersion });
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Получает закэшированный результат, если он есть.
 */
export function getFromCache(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.cachedAt >= CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

/**
 * Сохраняет результат в кэш.
 */
export function setCache(key: string, data: unknown): void {
  cache.set(key, { data, cachedAt: Date.now() });
}

/**
 * Очищает кэш (для тестов).
 */
export function clearCache(): void {
  cache.clear();
}
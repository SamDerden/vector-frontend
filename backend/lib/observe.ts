const SENSITIVE_KEY = /answer|comment|prompt|secret|token|password|authorization|cookie|api[-_]?key|proof|snapshot|body|input|dossier|text/i;
const SECRET_VALUE = /bearer\s+[a-z0-9._~+/-]+=*/i;

export type LogFields = Record<string, unknown>;

const metrics = new Map<string, number>();

export function countMetric(name: string): void {
  if (!/^[a-z0-9_.:-]{1,64}$/i.test(name)) return;
  metrics.set(name, (metrics.get(name) ?? 0) + 1);
}

export function readMetrics(): Record<string, number> {
  return Object.fromEntries(metrics);
}

export function resetMetrics(): void {
  metrics.clear();
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return "[redacted]";
    return value.length > 160 ? `${value.slice(0, 24)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = "[redacted]";
        continue;
      }
      output[key] = redact(item, depth + 1);
    }
    return output;
  }
  return "[redacted]";
}

export function logEvent(event: string, fields: LogFields = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...(redact(fields) as LogFields),
  };
  console.log(JSON.stringify(payload));
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

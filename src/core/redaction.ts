const SECRET_KEY = /(api[_-]?key|authorization|cookie|password|secret|token|credential)/i;
const MAX_TEXT = 240;
const MAX_ITEMS = 8;

type RedactedValue = string | number | boolean | null | RedactedValue[] | { [key: string]: RedactedValue };

export function truncate(value: string, max = MAX_TEXT): string {
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

export function redactText(value: string): string {
  return truncate(value)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function redactValue(value: unknown, depth = 0): RedactedValue {
  if (depth > 3) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    const output: { [key: string]: RedactedValue } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function summarize(value: unknown): string {
  if (typeof value === "string") return redactText(value);
  if (value === undefined) return "";
  return redactText(JSON.stringify(redactValue(value)));
}

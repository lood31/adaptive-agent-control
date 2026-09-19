import { createHash } from "node:crypto";

type CanonicalValue = string | number | boolean | null | undefined | CanonicalValue[] | { [key: string]: CanonicalValue };

function sortValue(value: unknown): CanonicalValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return value === undefined ? undefined : String(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "undefined";
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

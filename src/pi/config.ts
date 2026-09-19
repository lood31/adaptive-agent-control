import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POLICY_SPEC } from "../core/policy.js";
import type { AdaptiveConfig, ContentPolicy, ControlMode, Thresholds } from "../core/types.js";
import { CONTENT_POLICIES, CONTROL_MODES } from "../core/types.js";

export const DEFAULT_CONFIG: AdaptiveConfig = {
  mode: "observe",
  provider: "typesafe",
  model: "jev-latest",
  timeoutMs: 2000,
  maxRetries: 0,
  cooldownTurns: 2,
  stateWindow: 12,
  contentPolicy: "redacted-snippets",
  thresholds: { ...POLICY_SPEC.thresholds },
};

function numberOr(value: unknown, fallback: number, min = 0, max = 1): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function modeOr(value: unknown, fallback: ControlMode): ControlMode {
  return typeof value === "string" && (CONTROL_MODES as readonly string[]).includes(value)
    ? value as ControlMode
    : fallback;
}

function contentPolicyOr(value: unknown, fallback: ContentPolicy): ContentPolicy {
  return typeof value === "string" && (CONTENT_POLICIES as readonly string[]).includes(value)
    ? value as ContentPolicy
    : fallback;
}

function mergeThresholds(value: unknown): Thresholds {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    stuck: numberOr(input.stuck, DEFAULT_CONFIG.thresholds.stuck),
    planStale: numberOr(input.planStale, DEFAULT_CONFIG.thresholds.planStale),
    reflectionHelpful: numberOr(input.reflectionHelpful, DEFAULT_CONFIG.thresholds.reflectionHelpful),
    completionSupported: numberOr(input.completionSupported, DEFAULT_CONFIG.thresholds.completionSupported),
  };
}

export function loadConfig(cwd: string): AdaptiveConfig {
  const path = resolve(cwd, ".pi", "adaptive-control.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const input = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    return {
      ...DEFAULT_CONFIG,
      mode: modeOr(input.mode, DEFAULT_CONFIG.mode),
      provider: input.provider === "mock" ? "mock" : "typesafe",
      model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : DEFAULT_CONFIG.model,
      timeoutMs: numberOr(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, 100, 60_000),
      maxRetries: Math.round(numberOr(input.maxRetries, DEFAULT_CONFIG.maxRetries, 0, 3)),
      cooldownTurns: Math.round(numberOr(input.cooldownTurns, DEFAULT_CONFIG.cooldownTurns, 0, 20)),
      stateWindow: Math.round(numberOr(input.stateWindow, DEFAULT_CONFIG.stateWindow, 1, 50)),
      contentPolicy: contentPolicyOr(input.contentPolicy, DEFAULT_CONFIG.contentPolicy),
      thresholds: mergeThresholds(input.thresholds),
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

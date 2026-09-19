import { readFileSync } from "node:fs";
import { decideAction } from "../src/core/policy.js";
import type { AdaptiveConfig, ControlCheck, ObservedState, ProviderAssessment } from "../src/core/types.js";

const config: AdaptiveConfig = {
  mode: "observe",
  provider: "mock",
  model: "fixture",
  timeoutMs: 2_000,
  maxRetries: 0,
  cooldownTurns: 2,
  stateWindow: 12,
  contentPolicy: "redacted-snippets",
  thresholds: { stuck: 0.8, planStale: 0.8, reflectionHelpful: 0.7, completionSupported: 0.8 },
};

const lines = readFileSync(new URL("../../eval/cases.jsonl", import.meta.url), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
interface Fixture {
  id: string;
  check: ControlCheck;
  state: ObservedState;
  signals: ProviderAssessment["signals"];
  expected: string;
}

function parseFixture(line: string): Fixture | undefined {
  try {
    return JSON.parse(line) as Fixture;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    console.error(`Invalid fixture: ${reason}`);
    return undefined;
  }
}

let passed = 0;
for (const line of lines) {
  const fixture = parseFixture(line);
  if (!fixture) continue;
  const result = decideAction(fixture.check, { signals: fixture.signals, provider: "fixture", model: "fixture" }, fixture.state, config);
  const ok = result.action === fixture.expected;
  if (ok) passed += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${fixture.id}: ${result.action} (expected ${fixture.expected})\n`);
}
process.stdout.write(`fixture score: ${passed}/${lines.length}\n`);
if (passed !== lines.length) process.exitCode = 1;

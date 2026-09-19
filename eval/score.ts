import { readFileSync } from "node:fs";
import { decideAction } from "../src/core/policy.js";
import { DEFAULT_CONFIG } from "../src/pi/config.js";
import type { ControlAction, ControlCheck, ObservedState, ProviderAssessment } from "../src/core/types.js";

const config = { ...structuredClone(DEFAULT_CONFIG), mode: "observe" as const, provider: "mock" as const, model: "fixture" };
const lines = readFileSync(new URL("../../eval/cases.jsonl", import.meta.url), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);

interface Fixture {
  id: string;
  check: ControlCheck;
  state: ObservedState;
  signals: ProviderAssessment["signals"];
  needs_intervention: boolean;
  preferred_action: ControlAction;
  acceptable_actions: ControlAction[];
  severity: number;
  reason: string;
  eventually_recovered?: boolean;
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
let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
let trueNegative = 0;
const actionStats = new Map<ControlAction, { predicted: number; correct: number }>();

for (const line of lines) {
  const fixture = parseFixture(line);
  if (!fixture) continue;
  const result = decideAction(fixture.check, { signals: fixture.signals, provider: "fixture", model: "fixture" }, fixture.state, config);
  const ok = fixture.acceptable_actions.includes(result.action);
  if (ok) passed += 1;
  const predictedIntervention = result.action !== "CONTINUE";
  if (predictedIntervention && fixture.needs_intervention) truePositive += 1;
  else if (predictedIntervention) falsePositive += 1;
  else if (fixture.needs_intervention) falseNegative += 1;
  else trueNegative += 1;
  const stats = actionStats.get(result.action) ?? { predicted: 0, correct: 0 };
  stats.predicted += 1;
  if (result.action === fixture.preferred_action) stats.correct += 1;
  actionStats.set(result.action, stats);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${fixture.id}: ${result.action} (preferred ${fixture.preferred_action})\n`);
}

const precision = truePositive / Math.max(1, truePositive + falsePositive);
const recall = truePositive / Math.max(1, truePositive + falseNegative);
const falseInterventionRate = falsePositive / Math.max(1, falsePositive + trueNegative);
const missedInterventionRate = falseNegative / Math.max(1, falseNegative + truePositive);
process.stdout.write(`\npolicy fixture score: ${passed}/${lines.length}\n`);
process.stdout.write(`intervention precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} false-rate=${falseInterventionRate.toFixed(3)} missed-rate=${missedInterventionRate.toFixed(3)}\n`);
for (const [action, stats] of actionStats) {
  process.stdout.write(`${action.toLowerCase()} preferred-match=${stats.correct}/${stats.predicted}\n`);
}
if (passed !== lines.length) process.exitCode = 1;

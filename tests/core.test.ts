import assert from "node:assert/strict";
import { test } from "node:test";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { stableHash, stableStringify } from "../src/core/hash.js";
import { classifyOutcome, emptyOutcomeEvidence, recordOutcomeResult } from "../src/core/outcome.js";
import { decideAction } from "../src/core/policy.js";
import { StateTracker } from "../src/core/state-builder.js";
import { triggerFor } from "../src/core/trigger-engine.js";
import type { AdaptiveConfig, ObservedState } from "../src/core/types.js";
import { DEFAULT_CONFIG } from "../src/pi/config.js";
import { TypeSafeJevProvider } from "../src/providers/typesafe-jev.js";

const config: AdaptiveConfig = {
  ...structuredClone(DEFAULT_CONFIG),
  provider: "mock",
  model: "fixture",
};

function state(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    schemaVersion: 1,
    sessionId: "test",
    recentEvents: [],
    counters: { consecutiveFailures: 0, repeatedFailureCount: 0, editChurn: 0, turnsSinceIntervention: 10 },
    ...overrides,
  };
}

test("stable hashing is order independent", () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }));
});

test("state tracker counts repeated failures and redacts sensitive snippets", () => {
  const tracker = new StateTracker("test", 12);
  tracker.recordToolCall("bash", { command: "echo token=super-secret" });
  tracker.recordToolResult("bash", { command: "echo token=super-secret" }, true, "syntax error token=super-secret", { exitCode: 1 });
  tracker.recordToolResult("bash", { command: "echo token=super-secret" }, true, "syntax error token=super-secret", { exitCode: 1 });
  const current = tracker.getState();
  assert.equal(current.counters.consecutiveFailures, 2);
  assert.equal(current.counters.repeatedFailureCount, 2);
  assert.equal(triggerFor("reflection", current, config).shouldAssess, true);
  assert.equal(JSON.stringify(current).includes("super-secret"), false);
});

test("failure fingerprint distinguishes canonical CLI operations", () => {
  const pairs = [
    ["npm run test", "npm run build"],
    ["git status", "git checkout main"],
    ["python scripts/a.py", "python scripts/b.py"],
    ["pytest tests/a.test", "pytest tests/b.test"],
    ["cargo test", "cargo build"],
  ];
  for (const [left, right] of pairs) {
    const tracker = new StateTracker("test", 12);
    tracker.recordToolResult("bash", { command: left }, true, "syntax error", { exitCode: 1 });
    tracker.recordToolResult("bash", { command: right }, true, "syntax error", { exitCode: 1 });
    const current = tracker.getState();
    assert.equal(current.counters.consecutiveFailures, 2);
    assert.equal(current.counters.repeatedFailureCount, 1);
    assert.notEqual(current.recentEvents[0]?.fingerprint, current.recentEvents[1]?.fingerprint);
  }
  const tracker = new StateTracker("privacy", 12);
  tracker.recordToolResult("bash", { command: "npm run test" }, true, "syntax error", { exitCode: 1 });
  assert.equal(JSON.stringify(tracker.snapshot()).includes("npm run test"), false);
});

test("repeated failure history survives unrelated successful tools", () => {
  const tracker = new StateTracker("test", 12);
  const failure = () => tracker.recordToolResult("bash", { command: "npm run test" }, true, "syntax error", { exitCode: 1 });
  failure();
  tracker.recordToolResult("read", { path: "package.json" }, false, "contents");
  assert.equal(tracker.getState().counters.repeatedFailureCount, 0);
  failure();
  const current = tracker.getState();
  assert.equal(current.counters.consecutiveFailures, 1);
  assert.equal(current.counters.repeatedFailureCount, 2);
  assert.equal(triggerFor("trajectory", current, config).reason, "repeated_failure");
});

test("edit churn is windowed and repeated edit-failure cycles are detected", () => {
  const tracker = new StateTracker("test", 6);
  tracker.setPlan({ active: true });
  tracker.recordToolResult("edit", { path: "src/a.ts" }, false, "edited");
  tracker.recordToolResult("bash", { command: "npm run test" }, true, "syntax error", { exitCode: 1 });
  tracker.recordToolResult("edit", { path: "src/a.ts" }, false, "edited again");
  tracker.recordToolResult("bash", { command: "npm run test" }, true, "syntax error", { exitCode: 1 });
  assert.equal(tracker.getState().counters.editOscillationCount, 1);
  assert.equal(triggerFor("trajectory", tracker.getState(), config).reason, "edit_failure_oscillation");

  for (let index = 0; index < 6; index += 1) {
    tracker.recordToolResult("read", { path: `src/${index}.ts` }, false, "contents");
  }
  assert.equal(tracker.getState().counters.editChurn, 0);
  assert.equal(tracker.getState().counters.editOscillationCount, 0);
  assert.equal(triggerFor("trajectory", tracker.getState(), config).shouldAssess, false);
});

test("post-decision outcome requires a bounded body of evidence", () => {
  let evidence = emptyOutcomeEvidence();
  evidence = recordOutcomeResult(evidence, true, -2);
  assert.equal(classifyOutcome(evidence).label, "inconclusive");
  evidence = recordOutcomeResult(evidence, true, 0);
  const outcome = classifyOutcome(evidence);
  assert.equal(outcome.label, "improved");
  assert.equal(outcome.evidence.observedToolResults, 2);
});

test("metadata-only policy omits tool and completion snippets", () => {
  const tracker = new StateTracker("test", 12, undefined, "metadata-only");
  tracker.recordToolCall("read", { path: "private-source.ts" });
  tracker.recordToolResult("read", { path: "private-source.ts" }, false, "private file contents");
  tracker.recordCompletionAttempt("secret evidence", ["private criterion"]);
  const serialized = JSON.stringify(tracker.getState());
  assert.equal(serialized.includes("private-source"), false);
  assert.equal(serialized.includes("private file contents"), false);
  assert.equal(serialized.includes("secret evidence"), false);
  assert.equal(serialized.includes("private criterion"), false);
});

test("policy selects reflection, replan, and verification at thresholds", () => {
  const reflection = decideAction("reflection", {
    signals: { stuck: 0.9, reflectionLikelyHelpful: 0.9 },
    provider: "fixture",
    model: "fixture",
  }, state({ counters: { consecutiveFailures: 2, repeatedFailureCount: 2, editChurn: 0, turnsSinceIntervention: 10 } }), config);
  assert.equal(reflection.action, "REFLECT");

  const arbitration = decideAction("trajectory", {
    signals: { stuck: 0.9, planStale: 0.9, reflectionLikelyHelpful: 0.95 },
    provider: "fixture",
    model: "fixture",
  }, state({ counters: { consecutiveFailures: 2, repeatedFailureCount: 2, editChurn: 0, turnsSinceIntervention: 10 } }), config);
  assert.equal(arbitration.action, "REPLAN");

  const replan = decideAction("replan", {
    signals: { stuck: 0.9, planStale: 0.9 },
    provider: "fixture",
    model: "fixture",
  }, state({ plan: { active: true }, counters: { consecutiveFailures: 2, repeatedFailureCount: 1, editChurn: 1, turnsSinceIntervention: 10 } }), config);
  assert.equal(replan.action, "REPLAN");

  const verification = decideAction("completion", {
    signals: { completionSupported: 0.2 },
    provider: "fixture",
    model: "fixture",
  }, state({ completionAttempt: { claimedEvidence: "done", criteria: ["tests pass"] } }), config);
  assert.equal(verification.action, "VERIFY");
});

test("TypeSafe provider maps Jev answers and sends bounded state", async () => {
  let requestState: unknown;
  const fakeClient = {
    systemOne: async (request: { state: unknown }) => {
      requestState = request.state;
      return {
        model: "jev-latest",
        answers: {
          makingProgress: { type: "noul", noul: 0.2 },
          stuck: { type: "noul", noul: 0.9 },
          reflectionLikelyHelpful: { type: "noul", noul: 0.85 },
        },
        usage: { input_tokens: 11, output_tokens: 3 },
      };
    },
  } as unknown as TypeSafeClient;
  const provider = new TypeSafeJevProvider({ model: "jev-latest", timeoutMs: 2_000, maxRetries: 0, client: fakeClient });
  const result = await provider.assess("trajectory", {
    observedState: state({ goal: { objective: "token=super-secret" } }),
    agentContext: { hypothesis: "token=agent-secret", evidenceClaims: ["claim one"] },
  });
  assert.equal(result.signals.stuck, 0.9);
  assert.equal(result.signals.reflectionLikelyHelpful, 0.85);
  assert.equal(result.usage?.inputTokens, 11);
  assert.equal(JSON.stringify(requestState).includes("super-secret"), false);
  assert.equal(JSON.stringify(requestState).includes("agent-secret"), false);
  assert.equal(JSON.stringify(requestState).includes("untrusted_agent_hypothesis"), true);
});

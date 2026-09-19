import assert from "node:assert/strict";
import { test } from "node:test";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { stableHash, stableStringify } from "../src/core/hash.js";
import { decideAction } from "../src/core/policy.js";
import { StateTracker } from "../src/core/state-builder.js";
import { triggerFor } from "../src/core/trigger-engine.js";
import type { AdaptiveConfig, ObservedState } from "../src/core/types.js";
import { TypeSafeJevProvider } from "../src/providers/typesafe-jev.js";

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

test("policy selects reflection, replan, and verification at thresholds", () => {
  const reflection = decideAction("reflection", {
    signals: { stuck: 0.9, reflectionLikelyHelpful: 0.9 },
    provider: "fixture",
    model: "fixture",
  }, state({ counters: { consecutiveFailures: 2, repeatedFailureCount: 2, editChurn: 0, turnsSinceIntervention: 10 } }), config);
  assert.equal(reflection.action, "REFLECT");

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
  const result = await provider.assess("reflection", state({ goal: { objective: "token=super-secret" } }));
  assert.equal(result.signals.stuck, 0.9);
  assert.equal(result.signals.reflectionLikelyHelpful, 0.85);
  assert.equal(result.usage?.inputTokens, 11);
  assert.equal(JSON.stringify(requestState).includes("super-secret"), false);
});

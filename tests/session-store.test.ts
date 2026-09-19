import assert from "node:assert/strict";
import { test } from "node:test";
import { externalState, latestState, type PersistedControlState } from "../src/pi/session-store.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const tracker = {
  state: {
    schemaVersion: 1 as const,
    sessionId: "session",
    recentEvents: [],
    counters: { consecutiveFailures: 0, repeatedFailureCount: 0, editChurn: 0, turnsSinceIntervention: 10 },
  },
  assessedThisTurn: false,
};

const persisted: PersistedControlState = {
  schemaVersion: 1,
  mode: "assist",
  tracker,
  recentAssessments: [],
};

test("session store reads the newest adaptive entry and external goal/plan state", () => {
  const entries = [
    { type: "custom", customType: "goal-state", data: { goalId: "g1", objective: "ship", status: "active", successCriteria: ["tests pass"] } },
    { type: "custom", customType: "plan-state", data: { isActive: true, requirement: "ship", planFilePath: ".taiji-harness/ship/plan.md" } },
    { type: "custom", customType: "adaptive-control:v1", data: persisted },
  ] as unknown as SessionEntry[];
  assert.equal(latestState(entries)?.mode, "assist");
  const external = externalState(entries);
  assert.equal(external.goal?.id, "g1");
  assert.equal(external.plan?.active, true);
});

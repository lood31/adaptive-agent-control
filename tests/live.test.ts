import { test } from "node:test";
import { TypeSafeJevProvider } from "../src/providers/typesafe-jev.js";
import type { ObservedState } from "../src/core/types.js";

const live = Boolean(process.env.TYPESAFE_API_KEY);

test("optional live Jev smoke test", { skip: !live }, async () => {
  const state: ObservedState = {
    schemaVersion: 1,
    sessionId: "live-smoke",
    recentEvents: [],
    counters: { consecutiveFailures: 0, repeatedFailureCount: 0, editChurn: 0, turnsSinceIntervention: 0 },
    completionAttempt: { claimedEvidence: "smoke test", criteria: ["response returned"] },
  };
  const provider = new TypeSafeJevProvider({ model: "jev-latest", timeoutMs: 5_000, maxRetries: 0 });
  const result = await provider.assess("completion", state);
  if (typeof result.signals.completionSupported !== "number") throw new Error("Jev returned no completion signal");
});

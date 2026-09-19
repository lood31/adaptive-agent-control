import { test } from "node:test";
import { TypeSafeJevProvider } from "../src/providers/typesafe-jev.js";
import { VercelJevProvider } from "../src/providers/vercel-jev.js";
import type { ObservedState } from "../src/core/types.js";

const directLive = Boolean(process.env.TYPESAFE_API_KEY);
const vercelLive = Boolean(process.env.AI_GATEWAY_API_KEY);

function liveState(): ObservedState {
  return {
    schemaVersion: 1,
    sessionId: "live-smoke",
    recentEvents: [],
    counters: { consecutiveFailures: 0, repeatedFailureCount: 0, editChurn: 0, turnsSinceIntervention: 0 },
    completionAttempt: { claimedEvidence: "smoke test", criteria: ["response returned"] },
  };
}

test("optional live direct TypeSafe Jev smoke test", { skip: !directLive }, async () => {
  const provider = new TypeSafeJevProvider({ model: "jev-latest", timeoutMs: 5_000, maxRetries: 0 });
  const result = await provider.assess("completion", { observedState: liveState() });
  if (typeof result.signals.completionSupported !== "number") throw new Error("Jev returned no completion signal");
});

test("optional live Vercel Gateway Jev smoke test", { skip: !vercelLive }, async () => {
  const provider = new VercelJevProvider({ model: "typesafe-ai/jev", timeoutMs: 5_000, maxRetries: 0 });
  const result = await provider.assess("completion", { observedState: liveState() });
  if (typeof result.signals.completionSupported !== "number") throw new Error("Gateway Jev returned no completion signal");
});

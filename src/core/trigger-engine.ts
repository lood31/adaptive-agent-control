import type { AdaptiveConfig, ControlCheck, ObservedState } from "./types.js";

export interface TriggerDecision {
  shouldAssess: boolean;
  reason: string;
}

export function triggerFor(check: ControlCheck, state: ObservedState, _config: AdaptiveConfig): TriggerDecision {
  if (check === "completion") {
    return {
      shouldAssess: Boolean(state.completionAttempt),
      reason: state.completionAttempt ? "completion_attempt" : "no_completion_attempt",
    };
  }

  if (state.counters.consecutiveFailures >= 2 || state.counters.repeatedFailureCount >= 2) {
    return {
      shouldAssess: true,
      reason: state.counters.repeatedFailureCount >= 2 ? "repeated_failure" : "consecutive_failures",
    };
  }

  if (check === "replan" && state.plan?.active && state.counters.editChurn >= 4) {
    return { shouldAssess: true, reason: "high_edit_churn" };
  }

  return { shouldAssess: false, reason: "threshold_not_reached" };
}

export function inCooldown(state: ObservedState, config: AdaptiveConfig): boolean {
  return state.counters.turnsSinceIntervention < config.cooldownTurns;
}

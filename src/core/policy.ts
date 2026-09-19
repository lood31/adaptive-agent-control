import type {
  AdaptiveConfig,
  Assessment,
  ControlAction,
  ControlCheck,
  ObservedState,
  ProviderAssessment,
  Thresholds,
} from "./types.js";

/** The canonical shipped policy. Config may override these experimental parameters. */
export const POLICY_SPEC = Object.freeze({
  version: "v0.2.1",
  thresholds: Object.freeze({
    stuck: 0.8,
    planStale: 0.8,
    reflectionHelpful: 0.7,
    completionSupported: 0.8,
  } satisfies Thresholds),
  arbitration: Object.freeze(["REPLAN", "REFLECT", "CONTINUE"] as const),
});

function value(provider: ProviderAssessment, key: keyof ProviderAssessment["signals"]): number {
  const candidate = provider.signals[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

export function decideAction(
  check: ControlCheck,
  provider: ProviderAssessment,
  state: ObservedState,
  config: AdaptiveConfig,
): { action: ControlAction; reasonCodes: string[] } {
  const reasons: string[] = [];
  if (check === "completion") {
    const supported = value(provider, "completionSupported");
    if (supported >= config.thresholds.completionSupported) {
      return { action: "CONTINUE", reasonCodes: ["completion_evidence_supported"] };
    }
    reasons.push("completion_evidence_insufficient");
    if (!state.completionAttempt?.criteria.length) reasons.push("criteria_unavailable");
    return { action: "VERIFY", reasonCodes: reasons };
  }

  // Reflection and replanning compete on one signal set. The check identifies why
  // assessment was requested; it does not preselect the resulting action.
  const stuck = value(provider, "stuck");
  const planStale = value(provider, "planStale");
  const reflectionHelpful = value(provider, "reflectionLikelyHelpful");
  if (stuck >= config.thresholds.stuck && planStale >= config.thresholds.planStale) {
    return { action: "REPLAN", reasonCodes: ["stuck", "plan_stale"] };
  }
  if (stuck >= config.thresholds.stuck && reflectionHelpful >= config.thresholds.reflectionHelpful) {
    return { action: "REFLECT", reasonCodes: ["stuck", "reflection_likely_helpful"] };
  }
  if (stuck >= config.thresholds.stuck) reasons.push("stuck_signal_without_action_threshold");
  if (state.counters.consecutiveFailures > 0) reasons.push("recent_failure");
  return { action: "CONTINUE", reasonCodes: reasons.length ? reasons : ["progress_or_uncertain"] };
}

export function makeAssessment(
  check: ControlCheck,
  trigger: string,
  provider: ProviderAssessment,
  state: ObservedState,
  config: AdaptiveConfig,
  stateHash: string,
  latencyMs: number,
  agentContextProvided = false,
): Assessment {
  const decision = decideAction(check, provider, state, config);
  return {
    check,
    trigger,
    signals: provider.signals,
    action: decision.action,
    reasonCodes: decision.reasonCodes,
    provider: provider.provider,
    model: provider.model,
    latencyMs,
    ...(provider.usage ? { usage: provider.usage } : {}),
    stateHash,
    agentContextProvided,
    timestamp: Date.now(),
  };
}

export function makeFailOpenAssessment(
  check: ControlCheck,
  trigger: string,
  provider: string,
  model: string,
  stateHash: string,
  reason: string,
  latencyMs: number,
  agentContextProvided = false,
): Assessment {
  return {
    check,
    trigger,
    signals: {},
    action: "CONTINUE",
    reasonCodes: [`provider_error:${reason}`],
    provider,
    model,
    latencyMs,
    stateHash,
    agentContextProvided,
    timestamp: Date.now(),
  };
}

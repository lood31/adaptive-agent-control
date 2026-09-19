import type {
  AdaptiveConfig,
  Assessment,
  ControlAction,
  ControlCheck,
  ObservedState,
  ProviderAssessment,
} from "./types.js";

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
      reasons.push("completion_evidence_supported");
      return { action: "CONTINUE", reasonCodes: reasons };
    }
    reasons.push("completion_evidence_insufficient");
    if (!state.completionAttempt?.criteria.length) reasons.push("criteria_unavailable");
    return { action: "VERIFY", reasonCodes: reasons };
  }

  const stuck = value(provider, "stuck");
  const planStale = value(provider, "planStale");
  const reflectionHelpful = value(provider, "reflectionLikelyHelpful");
  if (check === "replan" && planStale >= config.thresholds.planStale && stuck >= config.thresholds.stuck) {
    return { action: "REPLAN", reasonCodes: ["plan_stale", "stuck"] };
  }
  if (check === "reflection" && stuck >= config.thresholds.stuck && reflectionHelpful >= config.thresholds.reflectionHelpful) {
    return { action: "REFLECT", reasonCodes: ["stuck", "reflection_likely_helpful"] };
  }
  if (stuck >= config.thresholds.stuck) reasons.push("stuck_signal_without_action_threshold");
  if (state.counters.consecutiveFailures > 0) reasons.push("recent_failure");
  return { action: "CONTINUE", reasonCodes: reasons.length ? reasons : ["progress_or_uncertain"] };
}

export function makeAssessment(
  check: ControlCheck,
  provider: ProviderAssessment,
  state: ObservedState,
  config: AdaptiveConfig,
  stateHash: string,
  latencyMs: number,
): Assessment {
  const decision = decideAction(check, provider, state, config);
  return {
    check,
    signals: provider.signals,
    action: decision.action,
    reasonCodes: decision.reasonCodes,
    provider: provider.provider,
    model: provider.model,
    latencyMs,
    ...(provider.usage ? { usage: provider.usage } : {}),
    stateHash,
    timestamp: Date.now(),
  };
}

export function makeFailOpenAssessment(
  check: ControlCheck,
  provider: string,
  model: string,
  stateHash: string,
  reason: string,
  latencyMs: number,
): Assessment {
  return {
    check,
    signals: {},
    action: "CONTINUE",
    reasonCodes: [`provider_error:${reason}`],
    provider,
    model,
    latencyMs,
    stateHash,
    timestamp: Date.now(),
  };
}

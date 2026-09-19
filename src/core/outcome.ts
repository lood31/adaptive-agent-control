import type { OutcomeEvidence, PostDecisionOutcome, PostDecisionOutcomeLabel } from "./types.js";

export const OUTCOME_WINDOW = Object.freeze({ maxToolResults: 6, maxTurns: 2 });

export function emptyOutcomeEvidence(): OutcomeEvidence {
  return {
    successfulTools: 0,
    failedTools: 0,
    repeatedFailureDelta: 0,
    observedToolResults: 0,
    observedTurns: 0,
  };
}

export function recordOutcomeResult(
  evidence: OutcomeEvidence,
  succeeded: boolean,
  repeatedFailureDelta: number,
): OutcomeEvidence {
  return {
    ...evidence,
    successfulTools: evidence.successfulTools + (succeeded ? 1 : 0),
    failedTools: evidence.failedTools + (succeeded ? 0 : 1),
    repeatedFailureDelta: evidence.repeatedFailureDelta + repeatedFailureDelta,
    observedToolResults: evidence.observedToolResults + 1,
  };
}

export function advanceOutcomeTurn(evidence: OutcomeEvidence): OutcomeEvidence {
  return { ...evidence, observedTurns: evidence.observedTurns + 1 };
}

export function outcomeWindowComplete(evidence: OutcomeEvidence): boolean {
  return evidence.observedToolResults >= OUTCOME_WINDOW.maxToolResults
    || evidence.observedTurns >= OUTCOME_WINDOW.maxTurns;
}

export function classifyOutcome(evidence: OutcomeEvidence): PostDecisionOutcome {
  let label: PostDecisionOutcomeLabel = "inconclusive";
  if (evidence.observedToolResults >= 2) {
    if (evidence.failedTools === 0 && evidence.successfulTools >= 2) label = "improved";
    else if (evidence.failedTools >= 2 && evidence.repeatedFailureDelta > 0) label = "regressed";
    else if (evidence.failedTools >= 2 && evidence.successfulTools === 0) label = "persisted";
  }
  return { label, evidence: structuredClone(evidence) };
}

import { redactValue } from "../core/redaction.js";
import type { AssessmentContext, ContentPolicy, ControlCheck, ObservedState, SignalSet } from "../core/types.js";

export const QUESTION_TEXT: Record<keyof SignalSet, string> = {
  makingProgress: "Is the agent's recent work producing observable progress toward the stated objective?",
  stuck: "Is the agent stuck in repeated low-yield work or recurring failures?",
  planStale: "Has new evidence invalidated an important assumption or sequence in the active plan?",
  reflectionLikelyHelpful: "Would explicitly examining assumptions likely change the next useful action?",
  completionSupported: "Does the available evidence support every stated success criterion for completion?",
};

export function signalNamesFor(check: ControlCheck): Array<keyof SignalSet> {
  return check === "completion"
    ? ["completionSupported"]
    : ["makingProgress", "stuck", "planStale", "reflectionLikelyHelpful"];
}

export function outboundContext(context: AssessmentContext, policy: ContentPolicy): object {
  if (policy === "redacted-snippets") {
    return {
      observedState: redactValue({
        ...context.observedState,
        // Generic redaction bounds arrays from the front; trajectories need the tail.
        recentEvents: context.observedState.recentEvents.slice(-8),
      }),
      ...(context.agentContext ? {
        agentContext: {
          trust: "untrusted_agent_hypothesis",
          value: redactValue(context.agentContext),
        },
      } : {}),
    };
  }

  const state: ObservedState = context.observedState;
  return {
    observedState: {
      schemaVersion: state.schemaVersion,
      sessionId: state.sessionId,
      goal: state.goal ? {
        present: true,
        status: state.goal.status,
        successCriteriaCount: state.goal.successCriteria?.length ?? 0,
      } : { present: false },
      plan: state.plan ? { present: true, active: state.plan.active } : { present: false },
      recentEvents: state.recentEvents.map((event) => ({
        kind: event.kind,
        tool: event.tool,
        ok: event.ok,
        fingerprint: event.fingerprint,
        timestamp: event.timestamp,
      })),
      counters: state.counters,
      completionAttempt: state.completionAttempt ? {
        present: true,
        criteriaCount: state.completionAttempt.criteria.length,
      } : { present: false },
    },
    agentContext: context.agentContext ? { present: true, trust: "untrusted_agent_hypothesis", contentOmitted: true } : { present: false },
  };
}

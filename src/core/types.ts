export const CONTROL_CHECKS = ["trajectory", "reflection", "replan", "completion"] as const;
export type ControlCheck = (typeof CONTROL_CHECKS)[number];

export const CONTROL_ACTIONS = ["CONTINUE", "REFLECT", "REPLAN", "VERIFY"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const CONTROL_MODES = ["off", "observe", "assist", "enforce"] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

export const CONTENT_POLICIES = ["metadata-only", "redacted-snippets", "full-local-only"] as const;
export type ContentPolicy = (typeof CONTENT_POLICIES)[number];
export const CONTROL_PROVIDERS = ["typesafe", "vercel", "mock"] as const;
export type ControlProvider = (typeof CONTROL_PROVIDERS)[number];

export interface GoalSnapshot {
  id?: string;
  objective?: string;
  status?: string;
  successCriteria?: string[];
}

export interface PlanSnapshot {
  active: boolean;
  requirement?: string;
  planFilePath?: string;
}

export type RecentEventKind = "tool_call" | "tool_result" | "edit" | "diagnostic";

export interface RecentEvent {
  kind: RecentEventKind;
  tool: string;
  ok?: boolean;
  fingerprint?: string;
  summary: string;
  timestamp: number;
}

export interface CompletionAttempt {
  claimedEvidence: string;
  criteria: string[];
}

export interface ObservedState {
  schemaVersion: 1;
  sessionId: string;
  goal?: GoalSnapshot;
  plan?: PlanSnapshot;
  recentEvents: RecentEvent[];
  counters: {
    consecutiveFailures: number;
    repeatedFailureCount: number;
    /** Number of completed edit operations still present in recentEvents. */
    editChurn: number;
    /** Repeated identical failures separated by one or more edits in recentEvents. */
    editOscillationCount?: number;
    turnsSinceIntervention: number;
  };
  completionAttempt?: CompletionAttempt;
}

export interface AgentAssessmentContext {
  hypothesis?: string;
  evidenceClaims?: string[];
}

export interface AssessmentContext {
  observedState: ObservedState;
  /** Agent-supplied context is a hypothesis, never runtime evidence. */
  agentContext?: AgentAssessmentContext;
}

export interface SignalSet {
  makingProgress: number;
  stuck: number;
  planStale: number;
  reflectionLikelyHelpful: number;
  completionSupported: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderAssessment {
  signals: Partial<SignalSet>;
  provider: string;
  model: string;
  usage?: ProviderUsage;
}

export interface DecisionProvider {
  assess(
    check: ControlCheck,
    context: AssessmentContext,
    signal?: AbortSignal,
  ): Promise<ProviderAssessment>;
}

export interface Assessment {
  check: ControlCheck;
  trigger: string;
  signals: Partial<SignalSet>;
  action: ControlAction;
  reasonCodes: string[];
  provider: string;
  model: string;
  latencyMs: number;
  usage?: ProviderUsage;
  stateHash: string;
  agentContextProvided: boolean;
  timestamp: number;
}

export interface PendingAdvice {
  check: ControlCheck;
  action: Exclude<ControlAction, "CONTINUE">;
  reasonCodes: string[];
  stateHash: string;
  telemetryId?: string;
  createdAt: number;
}

export type AdviceDelivery = "not-applicable" | "pending" | "delivered";
export type ObservedInterventionAction = "unknown";
export type PostDecisionOutcomeLabel = "improved" | "persisted" | "regressed" | "inconclusive";

export interface OutcomeEvidence {
  successfulTools: number;
  failedTools: number;
  repeatedFailureDelta: number;
  observedToolResults: number;
  observedTurns: number;
}

export interface PostDecisionOutcome {
  label: PostDecisionOutcomeLabel;
  evidence: OutcomeEvidence;
}

export interface ShadowTelemetry {
  schemaVersion: 2;
  id: string;
  trigger: string;
  check: ControlCheck;
  signals: Partial<SignalSet>;
  decision: ControlAction;
  mode: ControlMode;
  stateHash: string;
  provider: string;
  model: string;
  latencyMs: number;
  timestamp: number;
  adviceDelivery: AdviceDelivery;
  actionObserved: ObservedInterventionAction;
  outcomeWindow: OutcomeEvidence;
  postDecisionOutcome?: PostDecisionOutcome;
}

export interface Thresholds {
  stuck: number;
  planStale: number;
  reflectionHelpful: number;
  completionSupported: number;
}

export interface AdaptiveConfig {
  mode: ControlMode;
  provider: ControlProvider;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  cooldownTurns: number;
  stateWindow: number;
  contentPolicy: ContentPolicy;
  thresholds: Thresholds;
}

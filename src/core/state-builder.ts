import { stableHash } from "./hash.js";
import { redactValue, summarize, truncate } from "./redaction.js";
import type {
  CompletionAttempt,
  GoalSnapshot,
  ObservedState,
  PlanSnapshot,
  RecentEvent,
} from "./types.js";

export interface TrackerSnapshot {
  state: ObservedState;
  lastFailureFingerprint?: string;
  lastAssessmentKey?: string;
  assessedThisTurn: boolean;
}

function isEditTool(tool: string): boolean {
  return tool === "edit" || tool === "write" || tool === "apply_patch";
}

function errorClass(value: unknown): string {
  const text = summarize(value).toLowerCase();
  if (!text) return "unknown";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("permission")) return "permission";
  if (text.includes("not found")) return "not_found";
  if (text.includes("syntax")) return "syntax";
  return text.replace(/[^a-z0-9]+/g, "_").slice(0, 48) || "unknown";
}

function boundedEvents(events: RecentEvent[], limit: number): RecentEvent[] {
  return events.slice(-Math.max(1, limit));
}

export class StateTracker {
  private state: ObservedState;
  private readonly stateWindow: number;
  private lastFailureFingerprint: string | undefined;
  private lastAssessmentKey: string | undefined;
  private assessedThisTurn = false;

  constructor(sessionId: string, stateWindow = 12, snapshot?: TrackerSnapshot) {
    this.stateWindow = Math.max(1, stateWindow);
    this.state = snapshot?.state ?? {
      schemaVersion: 1,
      sessionId,
      recentEvents: [],
      counters: {
        consecutiveFailures: 0,
        repeatedFailureCount: 0,
        editChurn: 0,
        // A fresh session has no prior intervention, so it must not start in cooldown.
        turnsSinceIntervention: Number.MAX_SAFE_INTEGER,
      },
    };
    this.lastFailureFingerprint = snapshot?.lastFailureFingerprint;
    this.lastAssessmentKey = snapshot?.lastAssessmentKey;
    this.assessedThisTurn = snapshot?.assessedThisTurn ?? false;
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  snapshot(): TrackerSnapshot {
    return {
      state: structuredClone(this.state),
      ...(this.lastFailureFingerprint ? { lastFailureFingerprint: this.lastFailureFingerprint } : {}),
      ...(this.lastAssessmentKey ? { lastAssessmentKey: this.lastAssessmentKey } : {}),
      assessedThisTurn: this.assessedThisTurn,
    };
  }

  stateHash(): string {
    return stableHash(this.state);
  }

  getState(): ObservedState {
    return structuredClone(this.state);
  }

  setGoal(goal: GoalSnapshot | undefined): void {
    if (goal) this.state.goal = structuredClone(goal);
    else delete this.state.goal;
  }

  setPlan(plan: PlanSnapshot | undefined): void {
    if (plan) this.state.plan = structuredClone(plan);
    else delete this.state.plan;
  }

  recordToolCall(tool: string, input: unknown): void {
    const event: RecentEvent = {
      kind: isEditTool(tool) ? "edit" : "tool_call",
      tool: truncate(tool, 80),
      summary: summarize(redactValue(input)),
      timestamp: Date.now(),
    };
    this.push(event);
  }

  recordToolResult(tool: string, input: unknown, isError: boolean, content: unknown, details?: unknown): void {
    const explicitExitCode = details && typeof details === "object" && "exitCode" in details
      ? (details as { exitCode?: unknown }).exitCode
      : undefined;
    const failed = isError || (typeof explicitExitCode === "number" && explicitExitCode !== 0);
    const fingerprint = stableHash({
      tool,
      inputShape: shapeOf(input),
      errorClass: failed ? errorClass(content) : "ok",
    });

    if (failed) {
      this.state.counters.consecutiveFailures += 1;
      this.state.counters.repeatedFailureCount = this.lastFailureFingerprint === fingerprint
        ? this.state.counters.repeatedFailureCount + 1
        : 1;
      this.lastFailureFingerprint = fingerprint;
    } else {
      this.state.counters.consecutiveFailures = 0;
      this.state.counters.repeatedFailureCount = 0;
    }
    if (isEditTool(tool)) this.state.counters.editChurn += 1;

    this.push({
      kind: isEditTool(tool) ? "edit" : "tool_result",
      tool: truncate(tool, 80),
      ok: !failed,
      fingerprint,
      summary: summarize(content),
      timestamp: Date.now(),
    });

    if (tool === "goal_control" && !failed) delete this.state.completionAttempt;
  }

  recordCompletionAttempt(claimedEvidence: unknown, criteria: unknown): void {
    const normalizedCriteria = Array.isArray(criteria)
      ? criteria.filter((item): item is string => typeof item === "string").slice(0, 8).map((item) => truncate(item, 160))
      : [];
    this.state.completionAttempt = {
      claimedEvidence: summarize(claimedEvidence),
      criteria: normalizedCriteria,
    } satisfies CompletionAttempt;
  }

  clearCompletionAttempt(): void {
    delete this.state.completionAttempt;
  }

  canAssess(): boolean {
    return !this.assessedThisTurn;
  }

  assessmentKey(check: string): string {
    return `${check}:${this.stateHash()}`;
  }

  markAssessed(check: string, stateHash: string, intervened: boolean): void {
    this.assessedThisTurn = true;
    this.lastAssessmentKey = `${check}:${stateHash}`;
    if (intervened) this.state.counters.turnsSinceIntervention = 0;
  }

  alreadyAssessed(check: string): boolean {
    return this.lastAssessmentKey === this.assessmentKey(check);
  }

  endTurn(): void {
    this.state.counters.turnsSinceIntervention += 1;
    this.assessedThisTurn = false;
  }

  private push(event: RecentEvent): void {
    this.state.recentEvents = boundedEvents([...this.state.recentEvents, event], this.stateWindow);
  }
}

type InputShape = string | InputShape[] | { [key: string]: InputShape };

function shapeOf(value: unknown): InputShape {
  if (Array.isArray(value)) return value.map(shapeOf).slice(0, 8);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 8)
        .map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}

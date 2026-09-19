import { createHmac, randomBytes } from "node:crypto";
import { stableHash, stableStringify } from "./hash.js";
import { redactValue, summarize, truncate } from "./redaction.js";
import type {
  CompletionAttempt,
  ContentPolicy,
  GoalSnapshot,
  ObservedState,
  PlanSnapshot,
  RecentEvent,
} from "./types.js";

export interface TrackerSnapshot {
  state: ObservedState;
  lastFailureFingerprint?: string;
  fingerprintKey?: string;
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

interface OperationIdentity {
  executable?: string;
  operation?: string;
  argumentStructure?: string[];
  shape?: InputShape;
  normalizedInput?: ReturnType<typeof redactValue>;
}

function commandIdentity(command: string): OperationIdentity {
  const tokens = command.trim().split(/\s+/).slice(0, 16);
  const executable = (tokens[0]?.split(/[\\/]/).at(-1) ?? "unknown").toLowerCase();
  const positional = tokens.slice(1).filter((token) => !token.startsWith("-"));
  let operation = positional[0]?.toLowerCase() ?? "none";
  if (executable === "npm" && operation === "run") operation = `run:${positional[1]?.toLowerCase() ?? "unknown"}`;
  else if (["python", "python3", "py"].includes(executable)) operation = `script:${positional[0]?.toLowerCase() ?? "interactive"}`;
  else if (executable === "pytest") operation = `target:${positional[0]?.toLowerCase() ?? "all"}`;
  else if (executable === "git" || executable === "cargo") operation = positional[0]?.toLowerCase() ?? "none";
  return {
    executable,
    operation,
    argumentStructure: tokens.slice(1).map((token) => token.startsWith("-") ? token.replace(/=.*/, "=<value>") : "<arg>"),
  };
}

function operationIdentity(tool: string, input: unknown): OperationIdentity {
  if (tool === "bash" && input && typeof input === "object" && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") return commandIdentity(command);
  }
  return { shape: shapeOf(input), normalizedInput: redactValue(input) };
}

function eventSummary(policy: ContentPolicy, phase: "call" | "result", value: unknown, failed = false): string {
  if (policy === "redacted-snippets") return summarize(redactValue(value));
  if (phase === "call") return "tool input omitted";
  return failed ? "failed output omitted" : "successful output omitted";
}

export class StateTracker {
  private state: ObservedState;
  private readonly stateWindow: number;
  private readonly contentPolicy: ContentPolicy;
  private readonly fingerprintKey: string;
  private lastFailureFingerprint: string | undefined;
  private lastAssessmentKey: string | undefined;
  private assessedThisTurn = false;

  constructor(
    sessionId: string,
    stateWindow = 12,
    snapshot?: TrackerSnapshot,
    contentPolicy: ContentPolicy = "redacted-snippets",
  ) {
    this.stateWindow = Math.max(1, stateWindow);
    this.contentPolicy = contentPolicy;
    this.fingerprintKey = snapshot?.fingerprintKey ?? randomBytes(32).toString("hex");
    this.state = snapshot?.state ?? {
      schemaVersion: 1,
      sessionId,
      recentEvents: [],
      counters: {
        consecutiveFailures: 0,
        repeatedFailureCount: 0,
        editChurn: 0,
        editOscillationCount: 0,
        turnsSinceIntervention: Number.MAX_SAFE_INTEGER,
      },
    };
    this.refreshDerivedCounters();
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
      fingerprintKey: this.fingerprintKey,
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
    this.push({
      kind: "tool_call",
      tool: truncate(tool, 80),
      summary: eventSummary(this.contentPolicy, "call", input),
      timestamp: Date.now(),
    });
    this.refreshDerivedCounters();
  }

  recordToolResult(tool: string, input: unknown, isError: boolean, content: unknown, details?: unknown): void {
    const explicitExitCode = details && typeof details === "object" && "exitCode" in details
      ? (details as { exitCode?: unknown }).exitCode
      : undefined;
    const failed = isError || (typeof explicitExitCode === "number" && explicitExitCode !== 0);
    let exitClass = "unknown";
    if (typeof explicitExitCode === "number") exitClass = explicitExitCode === 0 ? "zero" : "nonzero";
    const fingerprint = createHmac("sha256", this.fingerprintKey)
      .update(stableStringify({ tool, operation: operationIdentity(tool, input), exitClass, errorClass: failed ? errorClass(content) : "ok" }))
      .digest("hex")
      .slice(0, 16);

    if (failed) {
      this.state.counters.consecutiveFailures += 1;
      this.lastFailureFingerprint = fingerprint;
    } else {
      this.state.counters.consecutiveFailures = 0;
      this.state.counters.repeatedFailureCount = 0;
    }

    this.push({
      kind: isEditTool(tool) ? "edit" : "tool_result",
      tool: truncate(tool, 80),
      ok: !failed,
      fingerprint,
      summary: eventSummary(this.contentPolicy, "result", content, failed),
      timestamp: Date.now(),
    });
    if (failed) {
      this.state.counters.repeatedFailureCount = this.state.recentEvents
        .filter((event) => event.ok === false && event.fingerprint === fingerprint)
        .length;
    }
    this.refreshDerivedCounters();

    if (tool === "goal_control" && !failed) delete this.state.completionAttempt;
  }

  recordCompletionAttempt(claimedEvidence: unknown, criteria: unknown): void {
    const normalizedCriteria = Array.isArray(criteria)
      ? criteria.filter((item): item is string => typeof item === "string").slice(0, 8).map((item) => truncate(item, 160))
      : [];
    this.state.completionAttempt = {
      claimedEvidence: this.contentPolicy === "redacted-snippets" ? summarize(claimedEvidence) : "claim omitted",
      criteria: this.contentPolicy === "redacted-snippets" ? normalizedCriteria : normalizedCriteria.map(() => "criterion omitted"),
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

  private refreshDerivedCounters(): void {
    this.state.counters.editChurn = this.state.recentEvents.filter((event) => event.kind === "edit").length;
    let previousFailure: string | undefined;
    let editedSinceFailure = false;
    let oscillations = 0;
    for (const event of this.state.recentEvents) {
      if (event.kind === "edit") {
        editedSinceFailure = true;
        continue;
      }
      if (event.ok !== false || !event.fingerprint) continue;
      if (editedSinceFailure && event.fingerprint === previousFailure) oscillations += 1;
      previousFailure = event.fingerprint;
      editedSinceFailure = false;
    }
    this.state.counters.editOscillationCount = oscillations;
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

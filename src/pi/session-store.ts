import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Assessment, ControlMode, GoalSnapshot, PendingAdvice, PlanSnapshot, ShadowTelemetry } from "../core/types.js";
import type { TrackerSnapshot } from "../core/state-builder.js";

export const CONTROL_ENTRY_TYPE = "adaptive-control:v1";

export interface PersistedControlState {
  schemaVersion: 1;
  mode: ControlMode;
  tracker: TrackerSnapshot;
  pendingAdvice?: PendingAdvice;
  recentAssessments: Assessment[];
  shadowTelemetry?: ShadowTelemetry[];
}

export function appendState(pi: ExtensionAPI, state: PersistedControlState): void {
  pi.appendEntry(CONTROL_ENTRY_TYPE, {
    ...state,
    recentAssessments: state.recentAssessments.slice(-20),
    ...(state.shadowTelemetry ? { shadowTelemetry: state.shadowTelemetry.slice(-100) } : {}),
  });
}

export function latestState(entries: readonly SessionEntry[]): PersistedControlState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isControlEntry(entry)) continue;
    return entry.data;
  }
  return undefined;
}

export function externalState(entries: readonly SessionEntry[]): { goal?: GoalSnapshot; plan?: PlanSnapshot } {
  const result: { goal?: GoalSnapshot; plan?: PlanSnapshot } = {};
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) continue;
    if (!result.goal && entry.customType === "goal-state") result.goal = readGoal(entry.data as Record<string, unknown>);
    if (!result.plan && entry.customType === "plan-state") result.plan = readPlan(entry.data as Record<string, unknown>);
    if (result.goal && result.plan) break;
  }
  return result;
}

function isControlEntry(entry: SessionEntry | undefined): entry is CustomEntry<PersistedControlState> & { data: PersistedControlState } {
  if (!entry || entry.type !== "custom" || entry.customType !== CONTROL_ENTRY_TYPE) return false;
  const data = entry.data;
  if (!data || typeof data !== "object") return false;
  const candidate = data as Record<string, unknown>;
  const validModes = ["off", "observe", "assist", "enforce"];
  return candidate.schemaVersion === 1
    && validModes.includes(String(candidate.mode))
    && Boolean(candidate.tracker && typeof candidate.tracker === "object")
    && Array.isArray(candidate.recentAssessments);
}

function readGoal(data: Record<string, unknown>): GoalSnapshot {
  const goal: GoalSnapshot = {};
  if (typeof data.goalId === "string") goal.id = data.goalId;
  if (typeof data.objective === "string") goal.objective = data.objective.slice(0, 400);
  if (typeof data.status === "string") goal.status = data.status;
  if (Array.isArray(data.successCriteria)) {
    goal.successCriteria = data.successCriteria.filter((item): item is string => typeof item === "string").slice(0, 8);
  }
  return goal;
}

function readPlan(data: Record<string, unknown>): PlanSnapshot {
  const plan: PlanSnapshot = {
    active: data.isActive === true,
  };
  if (typeof data.requirement === "string") plan.requirement = data.requirement.slice(0, 400);
  if (typeof data.planFilePath === "string") plan.planFilePath = data.planFilePath.slice(0, 240);
  return plan;
}

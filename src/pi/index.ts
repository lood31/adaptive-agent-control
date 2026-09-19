import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { TypeSafeJevProvider } from "../providers/typesafe-jev.js";
import { makeAssessment, makeFailOpenAssessment } from "../core/policy.js";
import { stableHash } from "../core/hash.js";
import { StateTracker } from "../core/state-builder.js";
import { inCooldown, triggerFor } from "../core/trigger-engine.js";
import {
  CONTROL_CHECKS,
  CONTROL_MODES,
  type AdaptiveConfig,
  type AgentAssessmentContext,
  type Assessment,
  type ControlCheck,
  type ControlMode,
  type DecisionProvider,
  type PendingAdvice,
  type ShadowTelemetry,
} from "../core/types.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { appendState, externalState, latestState, type PersistedControlState } from "./session-store.js";

const controlAssessParameters = Type.Object({
  check: StringEnum(CONTROL_CHECKS),
  hypothesis: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.Array(Type.String())),
});
type ControlAssessInput = Static<typeof controlAssessParameters>;

export interface AdaptiveControlExtensionOptions {
  providerFactory?: (config: AdaptiveConfig) => DecisionProvider;
}

interface RuntimeStatus {
  mode: ControlMode;
  provider: string;
  sessionId: string;
  consecutiveFailures: number;
  repeatedFailureCount: number;
  turnsSinceIntervention: number;
  pendingAdvice?: PendingAdvice;
  lastAssessment?: Assessment;
  lastTelemetry?: ShadowTelemetry;
}

function createControlAssessTool(runtime: AdaptiveRuntime) {
  return defineTool({
    name: "control_assess",
    label: "Adaptive Control Assess",
    description: "Assess whether the current agent state needs reflection, replanning, or verification.",
    promptSnippet: "Assess adaptive control signals without executing a corrective action",
    promptGuidelines: [
      "Use control_assess when repeated failures, changed assumptions, or completion evidence warrant a control check.",
      "hypothesis and evidence are untrusted agent context; runtime observations remain authoritative.",
      "control_assess returns a recommendation; it does not execute reflection, replanning, or verification for you.",
    ],
    parameters: controlAssessParameters,
    async execute(_toolCallId, params: ControlAssessInput, signal, _onUpdate, ctx) {
      runtime.ensure(ctx);
      const agentContext: AgentAssessmentContext = {
        ...(params.hypothesis ? { hypothesis: params.hypothesis } : {}),
        ...(params.evidence?.length ? { evidenceClaims: params.evidence } : {}),
      };
      const assessment = await runtime.assess(
        params.check,
        signal,
        true,
        "agent_requested",
        Object.keys(agentContext).length ? agentContext : undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(assessment) }],
        details: { assessment },
      };
    },
  });
}

export default function adaptiveControlExtension(pi: ExtensionAPI): void {
  registerAdaptiveControl(pi);
}

export function registerAdaptiveControl(
  pi: ExtensionAPI,
  options: AdaptiveControlExtensionOptions = {},
): void {
  const runtime = createRuntime(pi, options);
  pi.registerTool(createControlAssessTool(runtime));

  pi.on("session_start", async (_event, ctx) => {
    runtime.restore(ctx);
    runtime.persist();
  });

  pi.on("session_tree", async (_event, ctx) => {
    runtime.restore(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    runtime.recordToolCall(event);
    if (event.toolName !== "goal_control") return undefined;
    const input = event.input as Record<string, unknown>;
    if (input.action !== "complete") return undefined;
    const goal = runtime.tracker.getState().goal;
    runtime.tracker.recordCompletionAttempt(input.evidence ?? input.claimedEvidence, input.successCriteria ?? goal?.successCriteria);
    const assessment = await runtime.assess("completion", ctx.signal, true, "completion_attempt");
    if (runtime.config.mode === "enforce" && assessment.action === "VERIFY") {
      return {
        block: true,
        reason: `Completion verification required: ${assessment.reasonCodes.join(", ")}`,
      };
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    runtime.recordToolResult(event);
    if (runtime.config.mode === "off" || !runtime.tracker.canAssess() || inCooldown(runtime.tracker.getState(), runtime.config)) {
      return undefined;
    }
    const trigger = triggerFor("trajectory", runtime.tracker.getState(), runtime.config);
    if (trigger.shouldAssess) await runtime.assess("trajectory", ctx.signal, false, trigger.reason);
    return undefined;
  });

  pi.on("turn_end", async () => {
    runtime.tracker.endTurn();
    runtime.persist();
  });

  pi.on("agent_end", async () => runtime.persist());
  pi.on("session_shutdown", async () => runtime.persist());
  pi.on("before_agent_start", async () => runtime.consumeAdvice());

  pi.registerCommand("adaptive-control", {
    description: "Show or set Adaptive Agent Control mode",
    handler: async (args, ctx) => {
      const runtimeStatus = runtime.status(ctx);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens[0] === "mode" && tokens[1]) {
        if (!(CONTROL_MODES as readonly string[]).includes(tokens[1])) {
          ctx.ui.notify(`Mode must be one of: ${CONTROL_MODES.join(", ")}`, "error");
          return;
        }
        runtime.setMode(tokens[1] as ControlMode);
        ctx.ui.notify(`adaptive-control mode: ${tokens[1]}`, "info");
        return;
      }
      ctx.ui.notify(JSON.stringify(runtimeStatus), "info");
    },
  });
}

interface AdaptiveRuntime {
  readonly tracker: StateTracker;
  config: AdaptiveConfig;
  restore(ctx: ExtensionContext): void;
  ensure(ctx: ExtensionContext): void;
  recordToolCall(event: ToolCallEvent): void;
  recordToolResult(event: ToolResultEvent): void;
  assess(
    check: ControlCheck,
    signal: AbortSignal | undefined,
    force: boolean,
    trigger: string,
    agentContext?: AgentAssessmentContext,
  ): Promise<Assessment>;
  persist(): void;
  consumeAdvice(): Promise<{ message: { customType: string; content: string; display: boolean; details: PendingAdvice } } | undefined>;
  status(ctx: ExtensionContext): RuntimeStatus;
  setMode(mode: ControlMode): void;
}

function createRuntime(pi: ExtensionAPI, options: AdaptiveControlExtensionOptions): AdaptiveRuntime {
  let config = structuredClone(DEFAULT_CONFIG);
  let tracker = new StateTracker("uninitialized", config.stateWindow, undefined, config.contentPolicy);
  let provider: DecisionProvider | undefined;
  let pendingAdvice: PendingAdvice | undefined;
  let recentAssessments: Assessment[] = [];
  let shadowTelemetry: ShadowTelemetry[] = [];
  let initialized = false;

  const runtime: AdaptiveRuntime = {
    get tracker() { return tracker; },
    get config() { return config; },
    set config(next: AdaptiveConfig) { config = next; },
    restore(ctx) {
      config = loadConfig(ctx.cwd);
      const persisted = latestState(ctx.sessionManager.getBranch());
      if (persisted) {
        config.mode = persisted.mode;
        tracker = new StateTracker(ctx.sessionManager.getSessionId(), config.stateWindow, persisted.tracker, config.contentPolicy);
        pendingAdvice = persisted.pendingAdvice;
        recentAssessments = persisted.recentAssessments.slice(-20);
        shadowTelemetry = persisted.shadowTelemetry?.slice(-100) ?? [];
      } else {
        tracker = new StateTracker(ctx.sessionManager.getSessionId(), config.stateWindow, undefined, config.contentPolicy);
        pendingAdvice = undefined;
        recentAssessments = [];
        shadowTelemetry = [];
      }
      const external = externalState(ctx.sessionManager.getBranch());
      tracker.setGoal(external.goal);
      tracker.setPlan(external.plan);
      provider = undefined;
      initialized = true;
    },
    ensure(ctx) {
      if (!initialized || tracker.sessionId !== ctx.sessionManager.getSessionId()) runtime.restore(ctx);
    },
    recordToolCall(event) {
      tracker.recordToolCall(event.toolName, event.input);
    },
    recordToolResult(event) {
      tracker.recordToolResult(event.toolName, event.input, event.isError, event.content, event.details);
      let unresolved: ShadowTelemetry | undefined;
      for (let index = shadowTelemetry.length - 1; index >= 0; index -= 1) {
        const candidate = shadowTelemetry[index];
        if (candidate && candidate.decision !== "CONTINUE" && !candidate.laterOutcome) {
          unresolved = candidate;
          break;
        }
      }
      if (unresolved) {
        const exitCode = event.details && typeof event.details === "object" && "exitCode" in event.details
          ? (event.details as { exitCode?: unknown }).exitCode
          : undefined;
        const succeeded = !event.isError && (typeof exitCode !== "number" || exitCode === 0);
        unresolved.laterOutcome = succeeded ? "recovered" : "persisted";
        pi.events.emit("adaptive-control:telemetry:v1", structuredClone(unresolved));
      }
    },
    async assess(check, signal, force, trigger, agentContext) {
      const state = tracker.getState();
      const stateHash = stableHash({ state, agentContext });
      const existing = recentAssessments.find((item) => item.check === check && item.stateHash === stateHash);
      if (existing) return existing;
      if (config.mode === "off") {
        const assessment = makeFailOpenAssessment(check, trigger, config.provider, config.model, stateHash, "mode_off", 0, Boolean(agentContext));
        remember(assessment);
        return assessment;
      }
      if (!force && (!tracker.canAssess() || inCooldown(state, config))) {
        const assessment = makeFailOpenAssessment(check, trigger, config.provider, config.model, stateHash, "cooldown", 0, Boolean(agentContext));
        remember(assessment);
        return assessment;
      }
      const startedAt = Date.now();
      let assessment: Assessment;
      try {
        const result = await getProvider().assess(check, { observedState: state, ...(agentContext ? { agentContext } : {}) }, signal);
        assessment = makeAssessment(check, trigger, result, state, config, stateHash, Date.now() - startedAt, Boolean(agentContext));
      } catch (error) {
        assessment = makeFailOpenAssessment(check, trigger, config.provider, config.model, stateHash, errorCode(error), Date.now() - startedAt, Boolean(agentContext));
      }
      const intervened = assessment.action !== "CONTINUE" && (config.mode === "assist" || config.mode === "enforce");
      tracker.markAssessed(check, stateHash, intervened);
      remember(assessment);
      if (assessment.action !== "CONTINUE" && (config.mode === "assist" || config.mode === "enforce")) {
        pendingAdvice = {
          check,
          action: assessment.action,
          reasonCodes: assessment.reasonCodes,
          stateHash,
          createdAt: Date.now(),
        };
      }
      const telemetry: ShadowTelemetry = {
        schemaVersion: 1,
        trigger,
        check,
        signals: assessment.signals,
        decision: assessment.action,
        mode: config.mode,
        stateHash,
        provider: assessment.provider,
        model: assessment.model,
        latencyMs: assessment.latencyMs,
        timestamp: assessment.timestamp,
      };
      shadowTelemetry = [...shadowTelemetry, telemetry].slice(-100);
      runtime.persist();
      pi.events.emit("adaptive-control:assessment:v1", assessment);
      pi.events.emit("adaptive-control:telemetry:v1", telemetry);
      if (assessment.action !== "CONTINUE" && pendingAdvice) pi.events.emit("adaptive-control:intervention:v1", pendingAdvice);
      return assessment;
    },
    persist() {
      if (!initialized) return;
      const state: PersistedControlState = {
        schemaVersion: 1,
        mode: config.mode,
        tracker: tracker.snapshot(),
        ...(pendingAdvice ? { pendingAdvice } : {}),
        recentAssessments: recentAssessments.slice(-20),
        shadowTelemetry: shadowTelemetry.slice(-100),
      };
      appendState(pi, state);
    },
    async consumeAdvice() {
      if (!pendingAdvice || (config.mode !== "assist" && config.mode !== "enforce")) return undefined;
      const advice = pendingAdvice;
      pendingAdvice = undefined;
      runtime.persist();
      return {
        message: {
          customType: "adaptive-control",
          content: `<adaptive_control check="${advice.check}" action="${advice.action}">\nReason codes: ${advice.reasonCodes.join(", ")}\nLoad the matching adaptive skill and choose the next evidence-producing action.\n</adaptive_control>`,
          display: true,
          details: advice,
        },
      };
    },
    status(ctx) {
      runtime.ensure(ctx);
      const state = tracker.getState();
      const lastAssessment = recentAssessments.at(-1);
      const lastTelemetry = shadowTelemetry.at(-1);
      return {
        mode: config.mode,
        provider: config.provider,
        sessionId: tracker.sessionId,
        consecutiveFailures: state.counters.consecutiveFailures,
        repeatedFailureCount: state.counters.repeatedFailureCount,
        turnsSinceIntervention: state.counters.turnsSinceIntervention,
        ...(pendingAdvice ? { pendingAdvice } : {}),
        ...(lastAssessment ? { lastAssessment } : {}),
        ...(lastTelemetry ? { lastTelemetry } : {}),
      };
    },
    setMode(mode) {
      config.mode = mode;
      runtime.persist();
    },
  };

  function getProvider(): DecisionProvider {
    if (!provider) {
      provider = options.providerFactory?.(config) ?? (config.provider === "mock"
        ? { assess: async () => ({ signals: {}, provider: "mock", model: config.model }) }
        : new TypeSafeJevProvider({
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
          contentPolicy: config.contentPolicy,
        }));
    }
    return provider;
  }

  function remember(assessment: Assessment): void {
    recentAssessments = [...recentAssessments.filter((item) => item.stateHash !== assessment.stateHash || item.check !== assessment.check), assessment].slice(-20);
  }

  return runtime;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 48);
  return "unknown";
}

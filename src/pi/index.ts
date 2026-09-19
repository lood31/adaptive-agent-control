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
  type Assessment,
  type ControlCheck,
  type ControlMode,
  type DecisionProvider,
  type PendingAdvice,
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
}

function createControlAssessTool(runtime: AdaptiveRuntime) {
  return defineTool({
    name: "control_assess",
    label: "Adaptive Control Assess",
    description: "Assess whether the current agent state needs reflection, replanning, or verification.",
    promptSnippet: "Assess adaptive control signals without executing a corrective action",
    promptGuidelines: [
      "Use control_assess when repeated failures, changed assumptions, or completion evidence warrant a control check.",
      "control_assess returns a recommendation; it does not execute reflection, replanning, or verification for you.",
    ],
    parameters: controlAssessParameters,
    async execute(_toolCallId, params: ControlAssessInput, signal, _onUpdate, ctx) {
      runtime.ensure(ctx);
      const assessment = await runtime.assess(params.check, signal, true);
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
    const assessment = await runtime.assess("completion", ctx.signal, true);
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
    const state = runtime.tracker.getState();
    const reflectionTrigger = triggerFor("reflection", state, runtime.config);
    const replanTrigger = triggerFor("replan", state, runtime.config);
    if (reflectionTrigger.shouldAssess) {
      await runtime.assess("reflection", ctx.signal, false);
    } else if (replanTrigger.shouldAssess) {
      await runtime.assess("replan", ctx.signal, false);
    }
    return undefined;
  });

  pi.on("turn_end", async () => {
    runtime.tracker.endTurn();
    runtime.persist();
  });

  pi.on("agent_end", async () => {
    runtime.persist();
  });

  pi.on("session_shutdown", async () => {
    runtime.persist();
  });

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
  assess(check: ControlCheck, signal: AbortSignal | undefined, force: boolean): Promise<Assessment>;
  persist(): void;
  consumeAdvice(): Promise<{ message: { customType: string; content: string; display: boolean; details: PendingAdvice } } | undefined>;
  status(ctx: ExtensionContext): RuntimeStatus;
  setMode(mode: ControlMode): void;
}

function createRuntime(pi: ExtensionAPI, options: AdaptiveControlExtensionOptions): AdaptiveRuntime {
  let config = structuredClone(DEFAULT_CONFIG);
  let tracker = new StateTracker("uninitialized", config.stateWindow);
  let provider: DecisionProvider | undefined;
  let pendingAdvice: PendingAdvice | undefined;
  let recentAssessments: Assessment[] = [];
  let initialized = false;

  const runtime: AdaptiveRuntime = {
    get tracker() {
      return tracker;
    },
    get config() {
      return config;
    },
    set config(next: AdaptiveConfig) {
      config = next;
    },
    restore(ctx) {
      config = loadConfig(ctx.cwd);
      const persisted = latestState(ctx.sessionManager.getBranch());
      if (persisted) {
        config.mode = persisted.mode;
        tracker = new StateTracker(ctx.sessionManager.getSessionId(), config.stateWindow, persisted.tracker);
        pendingAdvice = persisted.pendingAdvice;
        recentAssessments = persisted.recentAssessments.slice(-20);
      } else {
        tracker = new StateTracker(ctx.sessionManager.getSessionId(), config.stateWindow);
        pendingAdvice = undefined;
        recentAssessments = [];
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
    },
    async assess(check, signal, force) {
      const state = tracker.getState();
      const stateHash = stableHash(state);
      const existing = recentAssessments.find((item) => item.check === check && item.stateHash === stateHash);
      if (existing) return existing;
      if (config.mode === "off") {
        const assessment = makeFailOpenAssessment(check, config.provider, config.model, stateHash, "mode_off", 0);
        remember(assessment);
        return assessment;
      }
      if (!force && (!tracker.canAssess() || inCooldown(state, config))) {
        const assessment = makeFailOpenAssessment(check, config.provider, config.model, stateHash, "cooldown", 0);
        remember(assessment);
        return assessment;
      }
      const startedAt = Date.now();
      let assessment: Assessment;
      try {
        const result = await getProvider().assess(check, state, signal);
        assessment = makeAssessment(check, result, state, config, stateHash, Date.now() - startedAt);
      } catch (error) {
        assessment = makeFailOpenAssessment(
          check,
          config.provider,
          config.model,
          stateHash,
          errorCode(error),
          Date.now() - startedAt,
        );
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
      runtime.persist();
      pi.events.emit("adaptive-control:assessment:v1", assessment);
      if (assessment.action !== "CONTINUE" && pendingAdvice) {
        pi.events.emit("adaptive-control:intervention:v1", pendingAdvice);
      }
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
      return {
        mode: config.mode,
        provider: config.provider,
        sessionId: tracker.sessionId,
        consecutiveFailures: state.counters.consecutiveFailures,
        repeatedFailureCount: state.counters.repeatedFailureCount,
        turnsSinceIntervention: state.counters.turnsSinceIntervention,
        ...(pendingAdvice ? { pendingAdvice } : {}),
        ...(lastAssessment ? { lastAssessment } : {}),
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

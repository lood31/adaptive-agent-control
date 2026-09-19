import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAdaptiveControl } from "../src/pi/index.js";
import type { AssessmentContext } from "../src/core/types.js";
import { VercelJevProvider } from "../src/providers/vercel-jev.js";
import { DiagnosedProviderError } from "../src/providers/provider-diagnostics.js";
import { StateTracker } from "../src/core/state-builder.js";

test("Gateway errors persist only safe diagnostics and remain fail-open", async () => {
  const entries: unknown[] = [];
  let tool: { execute: (id: string, params: { check: string }, signal: AbortSignal, update: undefined, ctx: ExtensionContext) => Promise<unknown> };
  const secret = "FAKE_PRIVATE_DIAGNOSTIC";
  const provider = new VercelJevProvider({ model: "fixture", timeoutMs: 1000, maxRetries: 0,
    evaluator: async () => { throw Object.assign(new Error(secret), {
      name: "GatewayResponseError", statusCode: 502, response: secret,
      cause: { name: secret, message: secret, headers: { authorization: secret } },
    }); },
  });
  registerAdaptiveControl({
    registerTool(value: unknown) { tool = value as typeof tool; },
    registerCommand() {}, on() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    events: { emit() {} },
  } as unknown as ExtensionAPI, { providerFactory: () => provider });
  const result = await tool!.execute("diagnostic", { check: "trajectory" }, new AbortController().signal, undefined, makeContext(entries));
  assert.ok(JSON.stringify(result).includes('"httpStatus":502'), "tool result exposes diagnostics");
  assert.ok(JSON.stringify(entries).includes('"httpStatus":502'), "session snapshot persists diagnostics");
  const serialized = JSON.stringify({ result, entries });
  assert.ok(serialized.includes('"httpStatus":502'));
  assert.ok(serialized.includes('"localTimeout":false'));
  assert.ok(serialized.includes('"callerAborted":false'));
  assert.ok(serialized.includes('"action":"CONTINUE"'));
  assert.ok(serialized.includes("provider_error:GatewayResponseError"));
  assert.ok(!serialized.includes(secret));
});

test("Gateway diagnostics distinguish local timeout from caller cancellation", async () => {
  for (const localTimeout of [true, false]) {
    const caller = new AbortController();
    if (!localTimeout) caller.abort(new Error("PRIVATE cancellation reason"));
    const provider = new VercelJevProvider({ model: "fixture", timeoutMs: localTimeout ? 5 : 1000, maxRetries: 0,
      evaluator: async ({ abortSignal }) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        abortSignal.throwIfAborted();
        throw new Error("expected cancellation");
      },
    });
    await assert.rejects(provider.assess("trajectory", { observedState: new StateTracker("probe").getState() }, caller.signal), (error: unknown) => {
      assert.ok(error instanceof DiagnosedProviderError);
      assert.equal(error.diagnostics.localTimeout, localTimeout);
      assert.equal(error.diagnostics.callerAborted, !localTimeout);
      assert.ok(!JSON.stringify(error).includes("PRIVATE"));
      return true;
    });
  }
  const cyclic = { name: "PRIVATE", statusCode: 900, cause: {} };
  cyclic.cause = cyclic;
  const bounded = new DiagnosedProviderError(cyclic, false, false);
  assert.equal(bounded.diagnostics.errorTypes.length, 4);
  assert.equal(bounded.diagnostics.httpStatus, undefined);
  assert.ok(!JSON.stringify(bounded).includes("PRIVATE"));
});

function makeContext(entries: unknown[]): ExtensionContext {
  return {
    cwd: process.cwd(),
    mode: "json",
    hasUI: false,
    ui: { notify: () => undefined } as unknown as ExtensionContext["ui"],
    sessionManager: {
      getSessionId: () => "integration-session",
      getBranch: () => entries,
    } as unknown as ExtensionContext["sessionManager"],
  } as unknown as ExtensionContext;
}

test("manual completion and hooks refresh same-session goal and plan state", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const entries: unknown[] = [];
  const contexts: AssessmentContext[] = [];
  let tool: { execute: (id: string, params: { check: string; evidence?: string[] }, signal: AbortSignal, update: undefined, ctx: ExtensionContext) => Promise<unknown> };
  const pi = {
    registerTool(value: unknown) { tool = value as typeof tool; },
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) { handlers.set(name, handler); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    events: { emit() {} },
  } as unknown as ExtensionAPI;
  registerAdaptiveControl(pi, {
    providerFactory: () => ({ assess: async (_check, context) => {
      contexts.push(context);
      return { signals: { completionSupported: 0.4 }, provider: "fixture", model: "fixture" };
    } }),
  });
  const ctx = makeContext(entries);
  await handlers.get("session_start")?.({}, ctx);
  const setExternal = (criterion: string, active: boolean) => {
    entries.push({ type: "custom", customType: "goal-state", data: { goalId: "new-goal", successCriteria: [criterion] } });
    entries.push({ type: "custom", customType: "plan-state", data: { isActive: active } });
  };
  setExternal("first criterion", true);
  await tool!.execute("manual", { check: "completion", evidence: ["untrusted claim"] }, new AbortController().signal, undefined, ctx);
  assert.deepEqual(contexts.at(-1)?.observedState.completionAttempt?.criteria, ["first criterion"]);
  assert.equal(contexts.at(-1)?.observedState.plan?.active, true);
  assert.deepEqual(contexts.at(-1)?.agentContext?.evidenceClaims, ["untrusted claim"]);
  assert.ok(!JSON.stringify(contexts.at(-1)?.observedState).includes("untrusted claim"));
  setExternal("updated criterion", false);
  await tool!.execute("updated", { check: "completion" }, new AbortController().signal, undefined, ctx);
  assert.deepEqual(contexts.at(-1)?.observedState.completionAttempt?.criteria, ["updated criterion"]);
  assert.equal(contexts.at(-1)?.observedState.plan?.active, false);
  await tool!.execute("trajectory", { check: "trajectory" }, new AbortController().signal, undefined, ctx);
  assert.equal(contexts.at(-1)?.observedState.completionAttempt, undefined);
  setExternal("gate criterion", true);
  await handlers.get("tool_call")?.({ toolName: "goal_control", input: { action: "complete", evidence: "done" } }, ctx);
  assert.deepEqual(contexts.at(-1)?.observedState.completionAttempt?.criteria, ["gate criterion"]);
});

test("Pi extension registers the tool, command, and observes repeated failures", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const entries: unknown[] = [];
  const emitted: unknown[] = [];
  const sent: Array<{ message: { details?: { telemetryId?: string } }; options: { deliverAs?: string } }> = [];
  let toolName = "";
  let registeredTool: {
    execute: (
      toolCallId: string,
      params: { check: "trajectory"; hypothesis?: string; evidence?: string[] },
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<unknown>;
  } | undefined;
  const providerContexts: AssessmentContext[] = [];
  let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    registerTool(tool: { name: string; execute: unknown }) { toolName = tool.name; registeredTool = tool as unknown as NonNullable<typeof registeredTool>; },
    registerCommand(_name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> }) { commandHandler = command.handler; },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) { handlers.set(event, handler); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    events: { emit(_name: string, data: unknown) { emitted.push(data); } },
    sendMessage(message: { details?: { telemetryId?: string } }, options: { deliverAs?: string }) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;

  registerAdaptiveControl(pi, {
    providerFactory: () => ({
      assess: async (_check, assessmentContext) => {
        providerContexts.push(assessmentContext);
        return {
        signals: { stuck: 0.95, planStale: 0.2, reflectionLikelyHelpful: 0.95 },
        provider: "fixture",
        model: "fixture",
      };
      },
    }),
  });
  const context = makeContext(entries);
  await handlers.get("session_start")?.({}, context);
  await commandHandler?.("mode assist", context);
  const resultHandler = handlers.get("tool_result");
  assert.ok(resultHandler);
  const failure = { toolName: "bash", input: { command: "false" }, isError: true, content: [{ type: "text", text: "syntax error" }], details: { exitCode: 1 } };
  await resultHandler(failure, context);
  await resultHandler(failure, context);
  assert.equal(toolName, "control_assess");
  assert.ok(emitted.some((item) => typeof item === "object" && item !== null && "action" in item && (item as { action?: string }).action === "REFLECT"));

  assert.equal(sent.length, 1, "automatic trajectory advice is sent during the current loop");
  assert.equal(sent[0]?.options.deliverAs, "steer");
  await commandHandler?.("mode enforce", context);
  const callHandler = handlers.get("tool_call");
  assert.ok(callHandler);
  const blocked = await callHandler({ toolName: "goal_control", input: { action: "complete", evidence: "done" } }, context) as { block?: boolean } | undefined;
  assert.equal(blocked?.block, true);

  assert.equal(sent.length, 2, "completion advice is sent even when the gate blocks");
  const advice = sent.at(-1);
  assert.equal(advice?.options.deliverAs, "steer");
  assert.ok(advice?.message?.details?.telemetryId);
  assert.equal(await handlers.get("before_agent_start")?.({}, context), undefined, "sent advice must not be injected again");
  assert.ok(emitted.some((item) => typeof item === "object" && item !== null
    && "id" in item && (item as { id?: string }).id === advice.message?.details?.telemetryId
    && "adviceDelivery" in item && (item as { adviceDelivery?: string }).adviceDelivery === "delivered"));

  const success = { toolName: "read", input: { path: "package.json" }, isError: false, content: [{ type: "text", text: "ok" }] };
  await resultHandler(success, context);
  await resultHandler(success, context);
  assert.equal(sent.length, 2, "later tool results must not resend advice");
  await handlers.get("turn_end")?.({}, context);
  await handlers.get("turn_end")?.({}, context);
  assert.ok(emitted.some((item) => typeof item === "object" && item !== null
    && "postDecisionOutcome" in item
    && (item as { postDecisionOutcome?: { label?: string } }).postDecisionOutcome?.label === "improved"));

  assert.ok(registeredTool);
  await registeredTool.execute(
    "tool-call",
    { check: "trajectory", hypothesis: "the dependency changed", evidence: ["test output ref"] },
    new AbortController().signal,
    undefined,
    context,
  );
  assert.equal(providerContexts.at(-1)?.agentContext?.hypothesis, "the dependency changed");
  assert.deepEqual(providerContexts.at(-1)?.agentContext?.evidenceClaims, ["test output ref"]);
  await resultHandler({ toolName: "control_assess", input: { check: "trajectory" }, isError: false, content: [] }, context);
  assert.equal(sent.length, 3, "manual advice is sent despite the assessment cooldown");
  assert.equal(await handlers.get("before_agent_start")?.({}, context), undefined);
  await handlers.get("agent_end")?.({}, context);
  assert.ok(emitted.some((item) => typeof item === "object" && item !== null
    && "postDecisionOutcome" in item
    && (item as { postDecisionOutcome?: { label?: string } }).postDecisionOutcome?.label === "inconclusive"));
  assert.ok(emitted.some((item) => typeof item === "object" && item !== null
    && "schemaVersion" in item && (item as { schemaVersion?: number }).schemaVersion === 2
    && "trigger" in item && "decision" in item));
});

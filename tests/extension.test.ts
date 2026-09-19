import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAdaptiveControl } from "../src/pi/index.js";
import type { AssessmentContext } from "../src/core/types.js";

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

test("Pi extension registers the tool, command, and observes repeated failures", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const entries: unknown[] = [];
  const emitted: unknown[] = [];
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
  const resultHandler = handlers.get("tool_result");
  assert.ok(resultHandler);
  const failure = { toolName: "bash", input: { command: "false" }, isError: true, content: [{ type: "text", text: "syntax error" }], details: { exitCode: 1 } };
  await resultHandler(failure, context);
  await resultHandler(failure, context);
  assert.equal(toolName, "control_assess");
  assert.ok(emitted.some((item) => typeof item === "object" && item !== null && "action" in item && (item as { action?: string }).action === "REFLECT"));

  await commandHandler?.("mode enforce", context);
  const callHandler = handlers.get("tool_call");
  assert.ok(callHandler);
  const blocked = await callHandler({ toolName: "goal_control", input: { action: "complete", evidence: "done" } }, context) as { block?: boolean } | undefined;
  assert.equal(blocked?.block, true);

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
  assert.ok(emitted.some((item) => typeof item === "object" && item !== null && "trigger" in item && "decision" in item));
});

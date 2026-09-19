import { experimental_evaluate as evaluate } from "ai";
import { DiagnosedProviderError } from "./provider-diagnostics.js";
import type { JSONValue } from "ai";
import type {
  AssessmentContext,
  ContentPolicy,
  ControlCheck,
  DecisionProvider,
  ProviderAssessment,
  SignalSet,
} from "../core/types.js";
import { outboundContext, QUESTION_TEXT, signalNamesFor } from "./jev-context.js";

interface BooleanAnswer {
  type: "boolean";
  probability: number;
}

type EvaluationState = Exclude<JSONValue, null | number | boolean>;

export interface VercelEvaluateRequest {
  model: string;
  state: EvaluationState;
  questions: Record<string, { type: "boolean"; instructions: string }>;
  maxRetries: number;
  abortSignal: AbortSignal;
}

export interface VercelEvaluateResult {
  answers: Record<string, BooleanAnswer>;
  usage?: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
  };
  response?: {
    modelId?: string;
  };
}

export type VercelEvaluator = (request: VercelEvaluateRequest) => Promise<VercelEvaluateResult>;

export interface VercelJevOptions {
  model: string;
  timeoutMs: number;
  maxRetries: number;
  contentPolicy?: ContentPolicy;
  evaluator?: VercelEvaluator;
}

export class VercelJevProvider implements DecisionProvider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly contentPolicy: ContentPolicy;
  private readonly evaluator: VercelEvaluator;

  constructor(options: VercelJevOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.contentPolicy = options.contentPolicy ?? "redacted-snippets";
    this.evaluator = options.evaluator ?? defaultEvaluator;
  }

  async assess(check: ControlCheck, context: AssessmentContext, signal?: AbortSignal): Promise<ProviderAssessment> {
    const questions = Object.fromEntries(signalNamesFor(check).map((name) => [name, {
      type: "boolean" as const,
      instructions: QUESTION_TEXT[name],
    }]));
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const abortSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let result: VercelEvaluateResult;
    try {
      result = await this.evaluator({
        model: this.model,
        state: outboundContext(context, this.contentPolicy) as EvaluationState,
        questions,
        maxRetries: this.maxRetries,
        abortSignal,
      });
    } catch (error) {
      throw new DiagnosedProviderError(error, timeoutSignal.aborted, signal?.aborted ?? false);
    }

    const signals: Partial<SignalSet> = {};
    for (const name of signalNamesFor(check)) {
      const answer = result.answers[name];
      if (answer?.type === "boolean" && Number.isFinite(answer.probability)) {
        signals[name] = Math.max(0, Math.min(1, answer.probability));
      }
    }

    const inputTokens = result.usage?.inputTokens;
    const outputTokens = result.usage?.outputTokens;
    return {
      signals,
      provider: "vercel",
      model: result.response?.modelId ?? this.model,
      ...(typeof inputTokens === "number" && typeof outputTokens === "number"
        ? { usage: { inputTokens, outputTokens } }
        : {}),
    };
  }
}

const defaultEvaluator: VercelEvaluator = async (request) => evaluate({
  model: request.model,
  state: request.state,
  questions: request.questions,
  maxRetries: request.maxRetries,
  abortSignal: request.abortSignal,
});

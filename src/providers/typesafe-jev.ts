import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType } from "@typesafe-ai/sdk";
import { redactValue } from "../core/redaction.js";
import type {
  ControlCheck,
  DecisionProvider,
  ObservedState,
  ProviderAssessment,
  SignalSet,
} from "../core/types.js";

interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface TypeSafeJevOptions {
  model: string;
  timeoutMs: number;
  maxRetries: number;
  client?: TypeSafeClient;
}

const QUESTION_TEXT = {
  makingProgress: "Is the agent's recent work producing observable progress toward the stated objective?",
  stuck: "Is the agent stuck in repeated low-yield work or recurring failures?",
  planStale: "Has new evidence invalidated an important assumption or sequence in the active plan?",
  reflectionLikelyHelpful: "Would explicitly examining assumptions likely change the next useful action?",
  completionSupported: "Does the available evidence support every stated success criterion for completion?",
} as const;

export class TypeSafeJevProvider implements DecisionProvider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private client: TypeSafeClient | undefined;

  constructor(options: TypeSafeJevOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.client = options.client;
  }

  async assess(check: ControlCheck, state: ObservedState, signal?: AbortSignal): Promise<ProviderAssessment> {
    const questions = questionsFor(check);
    const requestOptions = {
      timeout: this.timeoutMs,
      retry: { maxRetries: this.maxRetries },
      ...(signal ? { signal } : {}),
    };
    const response = await this.getClient().systemOne(
      {
        state: redactValue(state) as EntryType,
        questions,
        model: this.model,
      },
      requestOptions,
    );

    const answers = response.answers as Record<string, NoulAnswer>;
    const signals: Partial<SignalSet> = {};
    for (const name of Object.keys(questions)) {
      const answer = answers[name];
      if (answer?.type === "noul" && Number.isFinite(answer.noul)) {
        (signals as Record<string, number>)[name] = Math.max(0, Math.min(1, answer.noul));
      }
    }

    return {
      signals,
      provider: "typesafe",
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private getClient(): TypeSafeClient {
    if (!this.client) {
      this.client = new TypeSafeClient({
        defaultModel: this.model,
        timeout: this.timeoutMs,
        logLevel: "off",
        retry: { maxRetries: this.maxRetries },
      });
    }
    return this.client;
  }
}

function questionsFor(check: ControlCheck): Record<string, ReturnType<typeof noul>> {
  if (check === "completion") {
    return {
      completionSupported: noul(QUESTION_TEXT.completionSupported),
    };
  }

  const questions: Record<string, ReturnType<typeof noul>> = {
    makingProgress: noul(QUESTION_TEXT.makingProgress),
    stuck: noul(QUESTION_TEXT.stuck),
  };
  if (check === "replan") questions.planStale = noul(QUESTION_TEXT.planStale);
  if (check === "reflection") questions.reflectionLikelyHelpful = noul(QUESTION_TEXT.reflectionLikelyHelpful);
  return questions;
}

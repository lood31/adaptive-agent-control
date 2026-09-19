import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType } from "@typesafe-ai/sdk";
import type {
  AssessmentContext,
  ContentPolicy,
  ControlCheck,
  DecisionProvider,
  ProviderAssessment,
  SignalSet,
} from "../core/types.js";
import { outboundContext, QUESTION_TEXT, signalNamesFor } from "./jev-context.js";

interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface TypeSafeJevOptions {
  model: string;
  timeoutMs: number;
  maxRetries: number;
  contentPolicy?: ContentPolicy;
  client?: TypeSafeClient;
}

export class TypeSafeJevProvider implements DecisionProvider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly contentPolicy: ContentPolicy;
  private client: TypeSafeClient | undefined;

  constructor(options: TypeSafeJevOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.contentPolicy = options.contentPolicy ?? "redacted-snippets";
    this.client = options.client;
  }

  async assess(check: ControlCheck, context: AssessmentContext, signal?: AbortSignal): Promise<ProviderAssessment> {
    const questions = questionsFor(check);
    const requestOptions = {
      timeout: this.timeoutMs,
      retry: { maxRetries: this.maxRetries },
      ...(signal ? { signal } : {}),
    };
    const response = await this.getClient().systemOne(
      {
        state: outboundContext(context, this.contentPolicy) as EntryType,
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
  return Object.fromEntries(signalNamesFor(check).map((name) => [name, noul(QUESTION_TEXT[name])]));
}

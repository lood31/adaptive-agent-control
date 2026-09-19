import type { ProviderFailureDiagnostics } from "../core/types.js";

// Never copy arbitrary error strings, messages, response bodies, headers or causes.
const knownTypes = new Set([
  "Error", "TypeError", "AbortError", "TimeoutError", "APICallError", "AI_APICallError",
  "GatewayResponseError", "GatewayAuthenticationError", "GatewayInvalidRequestError",
  "GatewayRateLimitError", "GatewayModelNotFoundError", "GatewayInternalServerError",
]);

export class DiagnosedProviderError extends Error {
  readonly diagnostics: ProviderFailureDiagnostics;

  constructor(error: unknown, localTimeout: boolean, callerAborted: boolean) {
    super("Provider assessment failed");
    const errorTypes: string[] = [];
    let httpStatus: number | undefined;
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
      const item = current as { name?: unknown; statusCode?: unknown; cause?: unknown };
      errorTypes.push(typeof item.name === "string" && knownTypes.has(item.name) ? item.name : "OtherError");
      if (httpStatus === undefined && typeof item.statusCode === "number"
        && Number.isInteger(item.statusCode) && item.statusCode >= 100 && item.statusCode <= 599) {
        httpStatus = item.statusCode;
      }
      current = item.cause;
    }
    this.name = errorTypes[0] ?? "OtherError";
    this.diagnostics = {
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errorTypes,
      localTimeout,
      callerAborted,
    };
  }
}

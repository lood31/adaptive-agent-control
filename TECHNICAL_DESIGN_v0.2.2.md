# Adaptive Agent Control v0.2.2 技术设计

> 状态：Implemented
>
> 主题：Dual Jev transport adapters

v0.2.2 不改变 trigger、signal、policy 或 action。它只让同一组 Jev judgments 可以通过 TypeSafe 直连或 Vercel AI Gateway 传输。

## Provider 选择

`.pi/adaptive-control.json` 的 `provider` 支持：

- `typesafe`：`@typesafe-ai/sdk`，默认模型 `jev-latest`，读取 `TYPESAFE_API_KEY`；
- `vercel`：AI SDK 7 experimental evaluation API，默认模型 `typesafe-ai/jev`，读取 `AI_GATEWAY_API_KEY` 或 Vercel OIDC；
- `mock`：测试用途。

省略 `model` 时由 provider 决定默认模型，避免把 TypeSafe 模型名错误发送给 Gateway。

## 共享语义

`src/providers/jev-context.ts` 是两个 production adapter 的共享边界：

- 相同的五个窄问题；
- 相同的 `AssessmentContext` 映射；
- 相同的 `metadata-only`、`redacted-snippets` 与 `full-local-only` 出站规则；
- 相同的 untrusted agent hypothesis 标记。

TypeSafe 的 `noul` 答案映射为 signal probability；Vercel 的 boolean evaluation `probability` 映射为同一 signal。两者最终都返回 `ProviderAssessment`，deterministic policy 不感知传输渠道。

## 失败语义

两种 provider 的超时、鉴权错误和服务错误都由 runtime fail-open 为 `CONTINUE`，并记录 provider/model、latency 和错误 reason code。Vercel adapter 使用 `AbortSignal.timeout` 与上游 signal 合并，保留 controller 的取消语义。

## 运行要求与计费

AI SDK 7 要求 Node.js 22+，因此 package engine 下限同步升级。Jev 在 Vercel AI Gateway 上是计费模型；Vercel 账户赠送额度可以抵扣，但不构成永久免费承诺。

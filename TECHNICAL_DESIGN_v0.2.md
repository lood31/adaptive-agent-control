# Adaptive Agent Control v0.2 技术设计

> 状态：Implemented  
> 目标：修正 controller 语义，并建立可回放的控制闭环基础。

## 1. 架构边界

AAC 是 provider-neutral control plane：

```text
Core
  ObservedState / trigger / policy / telemetry
Provider
  TypeSafe Jev adapter
Pi Runtime Extension
  hooks / state / cooldown / persistence / completion gate
Portable Skills
  reflection / replan / verification behavior
```

Provider 估计窄信号；deterministic policy 决定动作；Skill 描述动作如何执行。

## 2. 统一 trajectory assessment

v0.1 分别运行 reflection 和 replan trigger，优先分支会导致 replan 饥饿。v0.2 将非完成态自动检查统一为 `trajectory`：

1. runtime failure 或 edit churn 生成 trigger candidate；
2. 一次 provider 请求同时评估 `makingProgress`、`stuck`、`planStale`、`reflectionLikelyHelpful`；
3. policy 按 `REPLAN > REFLECT > CONTINUE` 仲裁。

默认规范位于 `src/core/policy.ts::POLICY_SPEC`：

```ts
REPLAN  iff stuck >= 0.8 && planStale >= 0.8
REFLECT iff stuck >= 0.8 && reflectionLikelyHelpful >= 0.7
VERIFY  iff completionSupported < 0.8
```

配置阈值是显式实验参数，不是第二套隐藏 policy。

## 3. Assessment trust model

```ts
interface AssessmentContext {
  observedState: ObservedState;
  agentContext?: {
    hypothesis?: string;
    evidenceClaims?: string[];
  };
}
```

`observedState` 是 runtime observation。`agentContext` 来自 agent，自始至终标为 untrusted hypothesis。provider 可以用它生成信号，但 controller 不把 evidence claim 视为已验证证据。

## 4. Failure identity

指纹目标是识别“同一操作策略再次失败”，而不是“相同 JSON shape 的工具失败”。v0.2 使用：

```text
HMAC(sessionKey,
  tool,
  normalized operation identity,
  exit class,
  error class)
```

bash normalization 保留 executable、首个 operation 与参数结构，不持久化原始 command。generic tools 使用 bounded redacted input identity。key 随 session controller snapshot 保存，以保持恢复后的比较稳定性。

该设计降低原始输入泄漏和离线字典反推风险，但不是密码学匿名化承诺：有权读取完整 session state 的主体仍属于信任边界内。

## 5. Content policy

- `metadata-only`：本地和远端均不含工具内容片段；
- `redacted-snippets`：本地和远端使用有界脱敏片段；
- `full-local-only`：远端强制 metadata-only；当前本地实现仍只保留有界摘要。

所有模式都不应发送完整文件、完整 diff、环境变量或原始请求体。`full-local-only` 不等同于 controller 保存完整内容。

## 6. Shadow telemetry

每次 assessment 记录：

```text
trigger, check, signals, decision, mode,
stateHash, provider, model, latencyMs, timestamp, laterOutcome?
```

记录保留最近 100 条并持久化到 session，同时通过 `adaptive-control:telemetry:v1` 发出。`laterOutcome` 当前只根据下一次 tool result 标注 `recovered` / `persisted`，用于离线探索，不用于在线 policy，也不表达因果关系。

离线 replay 可以固定 trajectory，在不同 threshold、policy 和 provider 输出上重算 action。

## 7. Evaluation contract

fixture schema 包含：

```json
{
  "needs_intervention": true,
  "preferred_action": "REFLECT",
  "acceptable_actions": ["REFLECT"],
  "severity": 0.7,
  "reason": "same hypothesis retried",
  "eventually_recovered": true
}
```

v0.2 自带 32 条 synthetic policy fixtures，输出 intervention precision/recall、false/missed rate 和 action preferred-match。这只验证 policy 实现与标签管线，不验证 provider calibration 或真实任务收益。

真实研究阶段需要：

1. 30–100+ 条脱敏真实 trajectory；
2. 至少两名标注者与 disagreement 记录；
3. provider signal calibration；
4. observe/assist/enforce 对照；
5. latency、token 与成本统计；
6. 以最终任务结果验证 intervention utility。

## 8. v0.2 非目标

- 不新增除 `CONTINUE / REFLECT / REPLAN / VERIFY` 外的 action；
- 不让 provider 生成下一步动作；
- 不将 heuristic outcome 当作因果评价；
- 不声称 synthetic fixture score 代表实际有效性。

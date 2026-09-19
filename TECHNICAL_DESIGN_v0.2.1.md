# Adaptive Agent Control v0.2.1 技术设计

> 状态：Implemented  
> 主题：Measurement integrity patch

v0.2.1 不增加 action，也不调整 `REPLAN > REFLECT > CONTINUE` 的仲裁规则。它修复会污染后续真实轨迹评估的状态与 outcome 语义。

## 1. 有界编辑信号

v0.2 的 `editChurn` 是单调计数器；长 session 一旦达到阈值，冷却后会反复触发。v0.2.1 将它改为 `recentEvents` 窗口内已完成 edit result 的派生数量。tool call 不再重复计为 edit。

同时派生 `editOscillationCount`：当相同失败 fingerprint 之间出现 edit 时，计为一次 edit-failure oscillation。active plan 下的振荡优先产生 `edit_failure_oscillation` trigger；普通高编辑量使用 `high_recent_edit_churn`。

## 2. 重复失败历史

`consecutiveFailures` 与 `repeatedFailureCount` 现在表达不同概念：

- 任意成功结果会中断连续失败；
- 相同策略的失败仍可在有界事件窗口内匹配，即使中间发生无关的成功 read/status。

trigger 只在最新 tool result 失败时使用失败计数，避免成功操作本身触发旧失败。

## 3. CLI operation identity

failure fingerprint 仍为 session-local keyed HMAC。v0.2.1 在进入 HMAC 前增加小型 canonicalizer：

```text
npm run <script>
git <subcommand>
python|python3|py <script>
pytest <target>
cargo <subcommand>
```

canonical identity 只作为 HMAC 输入，不单独持久化。该实现不承诺解析完整 shell grammar；未知命令继续使用 executable、首个 positional operation 和参数结构 fallback。

## 4. Post-decision outcome window

删除下一次 tool result 即 `recovered/persisted` 的 v1 语义。`adaptive-control:telemetry:v2` 对非 `CONTINUE` 决策观察：

- 最多 6 个后续 tool result；或
- 最多 2 个后续 turn。

证据包括：

```ts
successfulTools
failedTools
repeatedFailureDelta
observedToolResults
observedTurns
```

输出 `improved | persisted | regressed | inconclusive`。这些标签只描述决策后的轨迹，不表达因果归因。session 在窗口完成前结束时会显式产生 `inconclusive`。

`control_assess` 自身的 tool call/result 不进入 trajectory state 或 outcome window，避免控制器观察自身，并避免把控制器调用成功误当成任务恢复。

## 5. 推荐暴露状态

Telemetry v2 分开记录：

```text
decisionProduced: 由 decision 字段表示
adviceDelivery: not-applicable | pending | delivered
actionObserved: unknown
```

observe 模式只产生 decision，`adviceDelivery=not-applicable`。assist/enforce 模式在 advice 注入 `before_agent_start` 后转为 `delivered`。当前没有可靠方法确认 agent 实际执行了推荐动作，因此不得推断 action adoption。

恢复旧 session 时，v1 telemetry 会被忽略，避免旧记录缺少 v2 outcome window 时污染或破坏运行时。

## 6. 后续边界

v0.2.1 仍不提供可独立导出的完整 trajectory episode，也不声称 post-decision outcome 能评估 intervention utility。下一阶段应构建：

1. 脱敏 trajectory export；
2. provider/policy offline replay；
3. 真实轨迹双人标注；
4. recommendation delivery、adoption 与最终任务结果的分层指标。

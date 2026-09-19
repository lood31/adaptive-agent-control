# Adaptive Agent Control

Pi Agent 的自适应控制平面：Decision Provider 只产出窄信号，确定性 policy 负责动作仲裁。

**v0.2.2** 提供 Pi Extension、三个可移植 Skill，以及 TypeSafe 直连和 Vercel AI Gateway 两种 Jev adapter。项目的核心不是“让小模型决定下一步”，而是把 `trajectory → signals → policy → recommendation → post-decision outcome` 做成可观察、可回放的控制闭环。

## 控制链

```text
Runtime trajectory
      ↓
Trigger candidates
      ↓
Single provider assessment
  makingProgress / stuck / planStale / reflectionLikelyHelpful
      ↓
Deterministic arbitration
  REPLAN > REFLECT > CONTINUE
```

Reflection 与 Replan 不再争夺调用机会。失败或高 edit churn 只触发一次 `trajectory` assessment；provider 在同一次请求中返回候选信号，policy 统一仲裁：

| 动作 | 规范条件 |
| --- | --- |
| `REPLAN` | `stuck ≥ 0.8 && planStale ≥ 0.8` |
| `REFLECT` | `stuck ≥ 0.8 && reflectionLikelyHelpful ≥ 0.7` |
| `VERIFY` | `completionSupported < 0.8` |
| `CONTINUE` | 以上均不满足 |

`src/core/policy.ts` 的 `POLICY_SPEC` 是默认 policy 的单一代码来源；配置可以覆盖阈值。README 只描述随当前版本发布的默认值。

## Provider 边界

Jev 只回答窄问题，不直接选择 action：

```text
makingProgress
stuck
planStale
reflectionLikelyHelpful
completionSupported
```

`DecisionProvider` 接收 `AssessmentContext`：

- `observedState`：controller 从 runtime 收集的观测；
- `agentContext`：`control_assess` 传入的 `hypothesis` / `evidence`，明确标记为 **untrusted agent hypothesis**。

agent 自报内容只能补充判断，不能升级为 runtime evidence。`typesafe` 是默认 adapter；也可选择 `vercel`，通过 Vercel AI Gateway 调用同一个 Jev。两种 adapter 共享问题定义、内容策略和 deterministic policy。

## 失败指纹

v0.2 的 failure fingerprint 使用 session-local keyed HMAC：

```text
HMAC(sessionKey,
  tool + normalized operation identity + exit class + error class)
```

bash identity 包含 executable、canonical operation 和参数结构。v0.2.1 对 `npm run <script>`、`git <subcommand>`、`python <script>`、`pytest <target>` 和 `cargo <subcommand>` 做小型归一化，因此 `npm run test` 与 `npm run build` 不再碰撞。原始 command 不进入 fingerprint；session key 只随 controller state 保存，用于跨 turn 保持一致。

## 内容与隐私策略

默认策略是 `redacted-snippets`。准确的边界是：AAC 可能向远端 provider 发送**有界、脱敏的最近工具活动片段**；不会发送完整文件、完整 diff、环境变量、凭据或原始请求体。

`.pi/adaptive-control.json` 支持：

| `contentPolicy` | 本地 controller state | 发给远端 provider |
| --- | --- | --- |
| `metadata-only` | 仅元数据 | 仅元数据 |
| `redacted-snippets` | 最多 240 字符的脱敏片段 | 同样的有界脱敏片段 |
| `full-local-only` | 当前实现仍仅保留有界本地摘要 | 仅元数据 |

`full-local-only` 的名字表达“内容不得离开本地”，并不承诺 AAC 持久化完整文件。TypeSafe 直连读取 `TYPESAFE_API_KEY`；Vercel Gateway 读取 `AI_GATEWAY_API_KEY`（或 Vercel OIDC）。凭据不写入 session。

## 窗口信号与 Shadow telemetry

`editChurn` 不再是会永久增长的累计值，而是当前 `recentEvents` 窗口内已完成 edit 的数量。controller 还会识别 `edit → 相同失败 → edit → 相同失败` 的 `edit_failure_oscillation`。重复失败历史保留在同一个有界窗口内，不会被中间无关的成功 read/status 错误抹掉。

每次 assessment 都会发出并持久化一个 `adaptive-control:telemetry:v2` 事件。v2 明确分开：

- `decision`：controller 产生的推荐；
- `adviceDelivery`：`not-applicable | pending | delivered`；
- `actionObserved`：当前只能诚实记录为 `unknown`；
- `postDecisionOutcome`：最多后续 6 个 tool result 或 2 个 turn 的非因果趋势标签。

趋势标签为 `improved | persisted | regressed | inconclusive`，并携带成功/失败工具数、重复失败变化和观察窗口大小。它描述“决策之后发生了什么”，**不声称建议被执行，也不声称结果由干预造成**。窗口不足或 session 提前结束时使用 `inconclusive`。旧 v1 telemetry 在恢复 session 时会被安全忽略。

## 安装与配置

```bash
npm install
npm run build
pi install .
```

默认是 `observe`：

```bash
/adaptive-control mode off
/adaptive-control mode observe
/adaptive-control mode assist
/adaptive-control mode enforce
```

项目配置 `.pi/adaptive-control.json`。TypeSafe 直连：

```json
{
  "mode": "assist",
  "provider": "typesafe",
  "model": "jev-latest",
  "contentPolicy": "redacted-snippets"
}
```

Vercel AI Gateway：

```json
{
  "mode": "assist",
  "provider": "vercel",
  "model": "typesafe-ai/jev",
  "contentPolicy": "redacted-snippets"
}
```

省略 `model` 时会按 provider 选择上述默认值。其他配置包括 `timeoutMs`、`maxRetries`、`cooldownTurns`、`stateWindow` 和 `thresholds`。provider 超时或报错时 fail-open；默认 2 秒超时、0 次重试。

Vercel adapter 使用 AI SDK 7 的 experimental evaluation API，因此需要 **Node.js 22+**。Jev 在 Gateway 上是计费模型；账户赠送额度可抵扣用量，但不等于永久免费。

## Skills

- `adaptive-reflection`：检查假设并选择不同的证据生产动作；
- `adaptive-replan`：计划无法解释新证据时做最小重规划；
- `adaptive-verification`：完成声明必须有逐项可检查证据。

Skill 负责行为流程；Extension/Hook 负责 runtime control。controller policy 不复制进 Skill prompt。

## 开发与评估

```bash
npm run typecheck
npm test
npm run eval:fixtures
npm pack --dry-run
```

`eval/cases.jsonl` 当前包含 32 条带标签 trajectory cases，并报告 intervention precision/recall、false/missed intervention rate 和 action preferred-match。它们用于验证 deterministic policy 与标注 schema，**不证明 AAC 对真实 agent 有效，也不证明 Jev signal quality**。下一步评估应使用脱敏真实轨迹、人工复标和离线 policy/provider replay。

设计文档：[v0.2](./TECHNICAL_DESIGN_v0.2.md) · [v0.2.1 measurement integrity](./TECHNICAL_DESIGN_v0.2.1.md) · [v0.2.2 dual Jev adapters](./TECHNICAL_DESIGN_v0.2.2.md)

# Adaptive Agent Control

Pi Agent 的自适应控制平面：Decision Provider 只产出窄信号，确定性 policy 负责动作仲裁。

**v0.2** 提供 Pi Extension、三个可移植 Skill，以及可替换的 TypeSafe Jev provider。项目的核心不是“让小模型决定下一步”，而是把 `trajectory → signals → policy → intervention → outcome` 做成可观察、可回放的控制闭环。

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

agent 自报内容只能补充判断，不能升级为 runtime evidence。TypeSafe Jev 是默认 adapter，不是控制器本身。

## 失败指纹

v0.2 的 failure fingerprint 使用 session-local keyed HMAC：

```text
HMAC(sessionKey,
  tool + normalized operation identity + exit class + error class)
```

bash identity 包含 executable、operation 和参数结构，因此 `npm test`、`python foo.py`、`git status` 不会仅因 input shape 相同而被计为同一策略。原始 command 不进入 fingerprint 或 telemetry；session key 只随 controller state 保存，用于跨 turn 保持一致。

## 内容与隐私策略

默认策略是 `redacted-snippets`。准确的边界是：AAC 可能向远端 provider 发送**有界、脱敏的最近工具活动片段**；不会发送完整文件、完整 diff、环境变量、凭据或原始请求体。

`.pi/adaptive-control.json` 支持：

| `contentPolicy` | 本地 controller state | 发给远端 provider |
| --- | --- | --- |
| `metadata-only` | 仅元数据 | 仅元数据 |
| `redacted-snippets` | 最多 240 字符的脱敏片段 | 同样的有界脱敏片段 |
| `full-local-only` | 当前实现仍仅保留有界本地摘要 | 仅元数据 |

`full-local-only` 的名字表达“内容不得离开本地”，并不承诺 AAC 持久化完整文件。API key 只从 `TYPESAFE_API_KEY` 读取，不写入 session。

## Shadow telemetry

每次 assessment 都会发出并持久化一个 `adaptive-control:telemetry:v1` 事件：

```json
{
  "schemaVersion": 1,
  "trigger": "repeated_failure",
  "check": "trajectory",
  "signals": {
    "stuck": 0.91,
    "planStale": 0.34,
    "reflectionLikelyHelpful": 0.82
  },
  "decision": "REFLECT",
  "mode": "observe",
  "stateHash": "…",
  "provider": "typesafe",
  "model": "jev-latest",
  "latencyMs": 104,
  "timestamp": 0,
  "laterOutcome": "recovered"
}
```

`laterOutcome` 是轻量启发式标签：干预后下一次成功 tool result 记为 `recovered`，失败记为 `persisted`。它适合 shadow analysis，不等同于因果归因。

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

项目配置 `.pi/adaptive-control.json`：

```json
{
  "mode": "assist",
  "model": "jev-latest",
  "timeoutMs": 2000,
  "cooldownTurns": 2,
  "contentPolicy": "redacted-snippets",
  "thresholds": {
    "stuck": 0.8,
    "planStale": 0.8,
    "reflectionHelpful": 0.7,
    "completionSupported": 0.8
  }
}
```

provider 超时或报错时 fail-open；默认 2 秒超时、0 次重试。

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

完整 v0.2 设计：[TECHNICAL_DESIGN_v0.2.md](./TECHNICAL_DESIGN_v0.2.md)

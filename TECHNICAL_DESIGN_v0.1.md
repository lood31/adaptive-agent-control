# Adaptive Agent Control v0.1 技术设计与实施计划

> 状态：Draft v0.1  
> 日期：2026-09-19  
> 目标：验证“快速决策模型能否作为 LLM Agent 的控制平面”，并以 Pi 作为首个参考实现。

## 1. 结论先行

v0.1 应做成一个 **Pi package**，同时发布：

1. **3 个可移植 Skill**：定义如何 replan、reflect、verify；
2. **1 个薄 Pi Extension**：观察 runtime、构造状态、调用决策模型、注入或拦截控制动作；
3. **1 个 provider-neutral core**：定义状态、信号、策略和 Decision Provider 接口；
4. **1 个 Jev adapter**：使用 `@typesafe-ai/sdk` 实现 Decision Provider。

核心原则：

- **Skill 负责“怎么做”**；Extension/Hook 负责“什么时候必须检查”；
- **Jev 只做窄判断，不生成计划、不执行修复、不直接控制安全策略**；
- **代码拥有控制流**：多个独立信号一次并行询问，最终动作由确定性 policy 组合；
- **不重写已有插件**：现有插件是传感器、执行器或基础设施；
- **v0.1 不接管每一步**：先做稀疏触发、可观测、可关闭、可评测的最小闭环。

## 2. 调研基线

### 2.1 当前项目状态

`D:\Adaptive Agent Control` 当前为空目录：无 Git、无 `package.json`、无源码。因此本文是 greenfield 设计；实施阶段第一步必须初始化仓库和测试基线。

本机运行基线：

- Pi：`0.85.1`
- Node.js：`v24.19.0`
- TypeSafe JS SDK 最新版本：`0.6.0`，要求 Node `>=20`
- Pi 官方能力：Extension lifecycle hooks、`tool_call` 阻断、`tool_result` 修改、custom tool、session entry、event bus、`before_agent_start` context 注入、package 同时分发 extensions/skills。

### 2.2 已安装插件及边界

| 组件 | 已观察版本 | v0.1 关系 | 决策 |
|---|---:|---|---|
| `@zhushanwen/pi-goal` | 0.14.5 | goal 状态、持续执行、`goal_control complete` | 集成，不重写；完成门只拦截它的 complete tool call |
| `@zhushanwen/pi-plan` | 0.4.9 | plan 状态与计划生成 | 读取状态、给出 REPLAN 建议；v0.1 不私自启动 plan mode |
| `pi-lens` | 4.2.1 | diagnostics、LSP/AST 工具、文件触达事件 | 作为验证证据来源；不复制 diagnostics 引擎 |
| `@jc4649/filechanges` | 0.1.0 | edit/write 基线与回滚 | 保持独立；v0.1 直接从 Pi tool events 统计 churn |
| `pi-observational-memory` | 3.1.3 | 长会话 observation/reflection | v0.1 不耦合其内部实现；后续只经公开契约接入 |
| `pi-subagents` | 0.69.0 | delegation executor | v0.2+ 动作提供者，不纳入 v0.1 action space |
| SoL-Pi | 已安装 | context/效率层 | 独立 baseline；与控制层做后续消融实验 |
| `ask-user-question`、`pi-web-access`、prompt snippets | 已安装 | ASK/SEARCH/提示注入 | 保持独立；v0.2+ 接 Action Router |
| bash-guard | 本地扩展 | 安全边界 | 永远位于 controller 下游，禁止被 Jev 覆盖 |
| dream-memory、cache optimizer、remote/UI/quiz/dictate/md-log | 已安装 | 非 v0.1 核心 | 不集成 |

### 2.3 对原 idea 的关键优化

1. **取消 `jev-decision` Skill**：本机已有通用 TypeSafe skill；项目 API 应隐藏 provider，避免把 Jev 写死在上层工作流。
2. **不让 Jev 直接选最终动作**：先输出可校准的原子信号，再由确定性 policy 决策，便于解释、测试和消融。
3. **不承诺“自动完成门覆盖所有回答”**：Pi 可以可靠阻断 tool call，但自然语言“我完成了”已生成后无法无痕撤回。v0.1 的强制门只覆盖 `goal_control(action="complete")`。
4. **不直接调用其他插件的私有函数**：Pi 没有通用的“扩展调用另一个扩展 tool”接口。v0.1 读取 session entries/event bus/已有 tool results，并向 agent 注入动作建议。
5. **限制自动触发频率**：deterministic trigger → Jev assessment → policy，而不是每步调用 Jev。
6. **把外发数据当成产品约束**：默认只发送最小、脱敏、截断状态；不发送完整文件、完整 diff、凭据或环境值。
7. **先 shadow/observe 再 enforce**：先量 false intervention、missed intervention、延迟与成本，再调阈值。

## 3. v0.1 范围

### 3.1 包含

- 三种控制检查：`REFLECT`、`REPLAN`、`VERIFY_COMPLETION`；
- 一个 agent 可主动调用的 `control_assess` tool；
- 两类 runtime 自动触发：重复失败、goal 完成尝试；
- 三档运行模式：`off | observe | assist | enforce`；
- Jev adapter 与可替换的 Decision Provider 接口；
- session 内轨迹摘要、决策记录、冷却与去重；
- fixture-based 离线评测和可选 live Jev smoke test；
- 三个 provider-neutral skills。

### 3.2 明确不做

- 自动 backtrack、search、ask、delegate、abort；
- 自动执行 `/plan` 或直接修改 plan 文件；
- 完整 trajectory replay/可视化平台；
- 长期记忆策略；
- 主动调用 pi-lens 私有 API；
- learned policy、在线训练或阈值自动优化；
- 替代 pi-goal、pi-plan、filechanges、bash-guard、SoL-Pi；
- 对 Claude Code/Codex 的 runtime adapter（Skill 文本可复用，但自动 Hook 仅 Pi）。

## 4. 总体架构

```text
Agent / Skills
      │ optional control_assess
      ▼
┌─────────────────────────────────────────────┐
│ Pi Extension                                │
│                                             │
│ Hooks ──► State Builder ──► Trigger Engine  │
│              │                    │          │
│              ▼                    ▼          │
│       ObservedState         DecisionProvider │
│                                   │          │
│                             Jev adapter       │
│                                   │          │
│              SignalSet ◄──────────┘          │
│                  │                           │
│                  ▼                           │
│       Deterministic Policy                   │
│          │ observe / assist / enforce        │
│          ▼                                   │
│ Pending Advice / Completion Block / Metrics │
└─────────────────────────────────────────────┘
      │
      ├─ VERIFY advice → agent 调 pi-lens/tests
      ├─ REFLECT advice → adaptive-reflection Skill
      └─ REPLAN advice  → adaptive-replan Skill → pi-plan（由 agent/用户启动）

Safety: proposed action → existing deterministic guards → environment
```

### 4.1 建议目录

```text
adaptive-agent-control/
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ core/
│  │  ├─ types.ts
│  │  ├─ state-builder.ts
│  │  ├─ trigger-engine.ts
│  │  ├─ policy.ts
│  │  └─ provider.ts
│  ├─ providers/
│  │  └─ typesafe-jev.ts
│  └─ pi/
│     ├─ index.ts
│     ├─ config.ts
│     ├─ session-store.ts
│     ├─ hooks.ts
│     ├─ tool.ts
│     └─ integrations/
│        ├─ goal.ts
│        ├─ plan.ts
│        └─ lens.ts
├─ skills/
│  ├─ adaptive-reflection/SKILL.md
│  ├─ adaptive-replan/SKILL.md
│  └─ adaptive-verification/SKILL.md
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  └─ fixtures/
└─ eval/
   ├─ cases.jsonl
   └─ score.ts
```

`package.json` 使用 Pi manifest 同时声明 `extensions` 和 `skills`；Pi SDK 包放 `peerDependencies`，`@typesafe-ai/sdk` 放 `dependencies`。

## 5. 核心接口

### 5.1 事实、推断与动作必须分层

```ts
type ControlCheck = "reflection" | "replan" | "completion";
type ControlAction = "CONTINUE" | "REFLECT" | "REPLAN" | "VERIFY";
type ControlMode = "off" | "observe" | "assist" | "enforce";

interface ObservedState {
  schemaVersion: 1;
  sessionId: string;
  goal?: {
    id?: string;
    objective?: string;
    status?: string;
    successCriteria?: string[];
  };
  plan?: {
    active: boolean;
    requirement?: string;
    planFilePath?: string;
  };
  recentEvents: Array<{
    kind: "tool_call" | "tool_result" | "edit" | "diagnostic";
    tool: string;
    ok?: boolean;
    fingerprint?: string;
    summary: string;
    timestamp: number;
  }>;
  counters: {
    consecutiveFailures: number;
    repeatedFailureCount: number;
    editChurn: number;
    turnsSinceIntervention: number;
  };
  completionAttempt?: {
    claimedEvidence: string;
    criteria: string[];
  };
}

interface SignalSet {
  makingProgress: number;       // Noul P(yes)
  stuck: number;                // Noul P(yes)
  planStale: number;            // Noul P(yes)
  reflectionLikelyHelpful: number;
  completionSupported: number;
}

interface Assessment {
  check: ControlCheck;
  signals: Partial<SignalSet>;
  action: ControlAction;
  reasonCodes: string[];        // deterministic, not generated prose
  provider: string;
  model: string;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  stateHash: string;
}

interface DecisionProvider {
  assess(check: ControlCheck, state: ObservedState, signal?: AbortSignal): Promise<{
    signals: Partial<SignalSet>;
    provider: string;
    model: string;
    usage?: { inputTokens: number; outputTokens: number };
  }>;
}
```

### 5.2 Jev 问题设计

Jev 请求只含结构化 state。一次请求并行询问当前 check 所需的独立 Noul：

- `making_progress`：最近动作是否产生了可观察的目标推进？
- `stuck`：是否在重复低收益策略或同类失败？
- `plan_stale`：新证据是否使当前 plan 的关键假设/顺序失效？
- `reflection_likely_helpful`：显式检查错误假设是否可能改变下一步？
- `completion_supported`：现有证据是否逐项支持 success criteria？

不得问宽泛问题“agent 下一步应该做什么”。Noul 没有单独 confidence；直接使用 yes probability。阈值是实验参数，不是模型真理。

### 5.3 v0.1 Policy

默认初始阈值（必须经 fixtures 校准）：

```ts
if (check === "completion") {
  return completionSupported >= 0.80 ? "CONTINUE" : "VERIFY";
}

if (planStale >= 0.80 && stuck >= 0.70) return "REPLAN";
if (stuck >= 0.80 && reflectionLikelyHelpful >= 0.70) return "REFLECT";
return "CONTINUE";
```

补充硬规则：

- 同一 `stateHash + check` 不重复推理；
- intervention 后至少冷却 2 个完整 turn；
- 每 turn 最多 1 次自动 Jev 请求；
- provider error/timeout 默认 **fail-open + 记录错误**，不能因外部服务故障锁死 agent；
- `enforce` 只对 `goal_control.complete` 的 `VERIFY` 结果阻断；REFLECT/REPLAN 仍为建议；
- safety action 永不交给 Jev 决定。

## 6. Pi Hook 与数据流

### 6.1 Session 恢复

`session_start`：

1. 从 `adaptive-control:v1` custom entries 恢复 mode、cooldown、最近 assessment；
2. 防御性读取最近的 `goal-state` 与 `plan-state` entry；
3. 不认识的字段忽略，解析失败降级为 unavailable，不阻断 Pi；
4. 注册/刷新状态 widget 与 `/adaptive-control status`。

注意：`goal-state`、`plan-state` 是现有插件的持久化事实，但不是正式共享 API。adapter 必须隔离解析，测试版本漂移；后续推动上游提供 versioned event/accessor。

### 6.2 轨迹采集

`tool_call`：记录 tool、参数摘要和 fingerprint；完整参数不持久化。  
`tool_result`：记录 `isError`、bash exit code（若存在）、截断后的结果摘要；更新失败连续数、重复失败、edit churn。  
`pilens:files:touched`：若事件可用，只收文件数量/路径哈希等低敏 metadata。  
`turn_end`：封存本 turn 摘要并裁剪 ring buffer（默认最近 12 个事件）。

失败 fingerprint：`toolName + normalizedInputShape + normalizedErrorClass` 的 hash；不把原始命令、源码或 token 写入 hash 前的持久化记录。

### 6.3 重复失败闭环

```text
tool_result(error)
  → counters/fingerprint 更新
  → deterministic trigger（连续失败≥2 或同 fingerprint≥2）
  → Jev 一次并行评估 progress/stuck/plan stale/reflection useful
  → policy
  → observe: 只记 assessment
     assist/enforce: 写 pending advice
  → 下一次 before_agent_start 注入一次性 <adaptive_control> 消息
  → Agent 加载对应 Skill；执行 reflect 或建议 replan
```

使用 `before_agent_start` 注入而不是在 `tool_result` 中强行开启新 turn，避免与 pi-goal 的 continuation、并行 tool batch 和其他 extension 竞争。

### 6.4 Completion Gate 闭环

```text
Agent 调 goal_control(action="complete", evidence=...)
  → tool_call hook 截获
  → State Builder 合并 goal criteria、evidence、近期测试/diagnostic 结果
  → Jev: completion_supported
  → policy
  → observe/assist: 不阻断，只记录/提示
  → enforce + unsupported: return { block: true, reason: ... }
  → Agent 进入 adaptive-verification Skill，补证据后重试
```

阻断原因只能说明缺哪类证据和下一步验证要求，不伪造 Jev 的自然语言解释。

如果不是 `pi-goal` 驱动，v0.1 只能在 `agent_end` 记录“疑似过早完成”，不能撤回已经生成的最终回答；这属于已知边界。

### 6.5 主动 Skill 闭环

Agent 在行为层认为可能需要控制检查时调用：

```ts
control_assess({
  check: "reflection" | "replan" | "completion",
  hypothesis?: string,
  evidence?: string[]
})
```

工具只接受小型补充信息；真实 runtime facts 由 extension 自己补齐，防止 agent 用自报状态替代证据。返回 `signals + action + reasonCodes`。

## 7. Skill 设计

### `adaptive-reflection`

触发：连续失败、同类错误重复、局部修复无改善。  
流程：调用 `control_assess(reflection)` → 若 REFLECT，检查失败假设、证据冲突、下一种不同策略 → 只输出一个有变化的下一步。  
禁止：把“再试一次相同步骤”包装成 reflection。

### `adaptive-replan`

触发：目标/scope 改变、新证据推翻关键假设、反思表明局部修复不足。  
流程：调用 `control_assess(replan)` → 若 REPLAN，标注保留/废弃/新增步骤 → 在 Pi 中建议进入现有 `pi-plan`，但不绕过用户或计划模式约束。  
禁止：仅因单次失败重写全盘计划。

### `adaptive-verification`

触发：准备声称完成、关键 claim 缺证据、completion gate 被阻断。  
流程：列出 claim→evidence 映射 → 使用现有 tests/pi-lens/read/diff 等收集真实证据 → 调用 `control_assess(completion)` → 只在支持时完成。  
禁止：把自述、预期结果或旧输出当成当前证据。

每个 Skill 在没有 `control_assess` tool 的其他 harness 中采用明确 fallback：按相同 rubric 自检，并标记“未经过 Decision Provider”。这使流程文本可移植，但不虚称跨 harness 已具备自动 Hook。

## 8. 配置、隐私与可观测性

建议项目配置 `.pi/adaptive-control.json`（仅项目已 trusted 时读取）：

```json
{
  "mode": "observe",
  "provider": "typesafe",
  "model": "jev-latest",
  "timeoutMs": 2000,
  "maxRetries": 0,
  "cooldownTurns": 2,
  "stateWindow": 12,
  "contentPolicy": "redacted-snippets",
  "thresholds": {
    "stuck": 0.8,
    "planStale": 0.8,
    "reflectionHelpful": 0.7,
    "completionSupported": 0.8
  }
}
```

- 凭据只读环境变量 `TYPESAFE_API_KEY`，禁止写 session/config/log；
- 自动调用前执行 secret redaction、长度上限和字段白名单；
- 默认不发送完整文件、完整 diff、环境变量、auth/cookie/token；
- SDK debug 日志关闭，避免 request body 泄漏；
- 2 秒单次超时、0 retry 是交互路径建议值；live 测试后再调整；
- session 中持久化 assessment、reason codes、usage、hash，不持久化完整外发 payload；
- event bus 发布 versioned 事件：`adaptive-control:assessment:v1`、`adaptive-control:intervention:v1`，供 md-log/未来 UI 消费。

## 9. 实施阶段

### Phase 0 — 初始化与契约冻结

- 初始化 npm/TypeScript/Pi package；
- 固定 `ObservedState`、`SignalSet`、`DecisionProvider`、`Assessment` schema；
- 建立脱敏 fixtures 和测试命令；
- 记录 Pi 0.85.1、TypeSafe SDK 0.6.0 兼容矩阵。

验收：`npm test` 与 `npm run typecheck` 在空实现骨架上通过；package manifest 能发现 extension 和 3 skills。

### Phase 1 — Core + Jev Adapter

- 实现 state hash、trigger、policy、cooldown、provider interface；
- 实现 Jev Noul 批量问题、timeout/abort/error mapping；
- 用 mock provider 覆盖阈值边界和失败降级。

验收：同一 state 去重；Jev 错误 fail-open；policy 表驱动测试全绿；无 API key 的默认测试不联网。

### Phase 2 — Pi Extension Observe Mode

- 注册 `control_assess`、`/adaptive-control status|mode`；
- 接入 session/tool/turn/before-agent hooks；
- 防御性读取 goal/plan entries；
- 实现 compact trajectory persistence 与 event bus。

验收：合成两次相同失败只产生一次 assessment；reload 后 mode/冷却恢复；敏感 fixture 不出现在 entry/log。

### Phase 3 — Assist + Enforced Completion

- pending advice 单次注入；
- 拦截 `goal_control complete`；
- 支持 observe/assist/enforce 行为差异；
- 与 pi-goal continuation 做集成测试，确保不额外制造无限 turn。

验收：unsupported completion 在 enforce 被 block，补齐证据后允许；observe 从不阻断；provider outage 不锁死 goal。

### Phase 4 — Skills + Evaluation

- 编写 3 个 Skill 与 fallback；
- 建立至少 30 个标注 trajectory fixtures：正常推进、重复失败、计划过时、证据不足、真实完成各类均覆盖；
- 输出 precision/recall、false intervention、missed intervention、平均延迟、token usage；
- 用 `off/observe/assist/enforce` 做最小对照。

验收：fixture 评测可一条命令复跑并输出 JSON；阈值有数据依据；README 清楚区分已实现能力与 future work。

## 10. 测试与 v0.1 完成标准

建议命令：

```bash
npm run typecheck
npm test
npm run eval:fixtures
TYPESAFE_API_KEY=... npm run test:live   # 可选，不进默认 CI
```

v0.1 发布门槛：

1. Core、Jev adapter、Pi extension、3 skills 均由同一 package 分发；
2. 30+ 脱敏 fixtures 可复跑，报告关键分类与成本/延迟指标；
3. observe/assist/enforce 三模式行为有集成测试；
4. `goal_control.complete` 能被可靠验证和阻断，provider 故障能 fail-open；
5. 重复失败不会造成 Jev 调用风暴或 turn 自激循环；
6. 默认日志/session 不含 API key、完整源码、完整 diff 或原始外发 payload；
7. 与当前 pi-goal、pi-plan、pi-lens、filechanges 同时加载时无 tool/command 名冲突；
8. README 明确说明：自然语言完成无法强制拦截、plan 不会被自动启动、其他 harness 只有 Skill 流程复用。

## 11. 主要风险与缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| goal/plan session entry 属于非正式契约 | 插件升级后解析漂移 | adapter 隔离、schema guard、版本 fixtures、失败降级；推动上游公开 event/accessor |
| 多 extension hook 顺序与 continuation 竞争 | 重复 turn、丢 advice | 只写 pending state，在下一次 `before_agent_start` 注入；每 turn 上限与 state hash 去重 |
| Jev 阈值未经领域校准 | 误触发或漏触发 | 默认 observe；fixture+shadow metrics 后才建议 enforce |
| 外发 trajectory 泄露代码/凭据 | 安全与隐私问题 | 字段白名单、脱敏、截断、无 debug body、内容策略可配置 |
| 把相关性当进展 | 错误判断 stuck/progress | facts 与 inference 分层；测试/diagnostic delta 优先于自述 |
| Skill 太多且触发描述重叠 | agent 加载错误 Skill | 仅 3 个行为 Skill；互斥触发条件；统一调用 `control_assess` |
| completion gate 过度依赖 Jev | 网络故障阻塞完成 | provider error 默认 fail-open；确定性检查先行；明确 telemetry |
| “跨 agent 复用”被夸大 | 预期不符 | v0.1 只保证 Agent Skills 文本可移植；runtime automation 明确为 Pi-only |

## 12. 后续路线（不进入 v0.1）

- v0.2：公开 Integration Provider 协议；接 ASK/SEARCH/DELEGATE/BACKTRACK；与 pi-lens 建立结构化 diagnostics bus；支持其他 decision provider。
- v0.3：memory control、跨 session 学习、阈值校准工具、trajectory replay UI。
- Research：比较 no controller / fixed rules / heuristic / Jev / Jev+rules / LLM judge；主指标使用 success-cost frontier，并单独报告 false/missed intervention、recovery rate 和 premature completion。

## 13. 最终架构判断

这个项目不应成为另一个“大而全 Agent framework”。它应该是一个薄的、可观测的、可替换 provider 的 **control plane**：现有 Pi 插件继续拥有 planning、goal loop、diagnostics、memory、delegation、安全和效率；Adaptive Agent Control 只回答“现在是否值得介入，以及介入类型是什么”。

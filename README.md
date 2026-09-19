# Adaptive Agent Control

> 给 Pi Agent 装一个"会自我管理"的控制平面：反复失败就反思、计划失效就重规划、声称完成就验证。

Adaptive Agent Control 是一个**提供方无关（provider-neutral）的自适应控制平面**：它观察 Agent 运行时产生的证据，向可替换的决策提供方（默认 [TypeSafe Jev](https://typesafe.ai)）请求窄粒度的语义判断，再由**确定性策略**决定下一步动作——继续、反思、重规划、还是验证。v0.1 交付一个 Pi 扩展 + 三个可复用 Skill。

## 它解决什么问题

LLM Agent 在长任务里经常自己"带偏"：

- 同一个命令反复失败，Agent 却用几乎一样的方式重试，没有停下来反思；
- 目标和范围变了，手里的计划却还是旧版，Agent 闷头照旧执行；
- 任务根本没做完，Agent 就声称"完成"了。

这些问题靠提示词很难根治。Adaptive Agent Control 把**"何时干预"的语义判断**（Jev，~100ms 的 System One 模型）和**"怎么干预"的确定性策略**（本地代码，无随机性）分开：判断可以换模型、换厂商，策略永远由你掌控。

## 核心功能

| 功能 | 说明 |
| --- | --- |
| 🔁 **自适应反思** | 检测连续失败 / 重复同一种失败，触发 `adaptive-reflection`，建议换策略而不是硬碰硬重试 |
| 🗺️ **自适应重规划** | 当计划落后于证据（stale plan）时触发 `adaptive-replan`，最小化修订计划而非推倒重来 |
| ✅ **完成验证** | Agent 调用 `goal_control(action="complete")` 时先让 Jev 判断证据是否真的支撑完成声明，`enforce` 模式下可**阻止**未经验证的完成 |
| 🎛️ **四级模式** | `off` / `observe` / `assist` / `enforce`，从纯观察（不打扰）到强制门禁（阻止错误完成）平滑升级 |
| 🔒 **隐私内建** | 只发送**脱敏、截断、哈希后**的最小状态元数据；不发送完整文件、diff、凭据、token 或原始请求体 |
| 🧩 **提供方可替换** | 通过 `DecisionProvider` 接口接入任意决策模型；当前内置 TypeSafe Jev adapter |
| 🛡️ **故障开放（fail-open）** | Jev 超时/出错时策略放行并记录，外部服务故障不会锁死 Agent |
| 📦 **可复用 Skills** | `adaptive-reflection` / `adaptive-replan` / `adaptive-verification` 三个标准 Agent Skill，无扩展也能手动使用 |

## 架构速览

```text
┌───────────────────────────── Pi 扩展（src/pi/）────────────────────────────┐
│  tool_call / tool_result / turn_end / before_agent_start 生命周期钩子        │
│  control_assess 工具 · /adaptive-control 命令 · 分支感知状态持久化            │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ 观察到的状态（脱敏）
┌──────────────▼──────────────────────────────────────────────────────────────┐
│  确定性触发器（src/core/trigger-engine.ts）                                   │
│  连续失败 ≥ 阈值？ 计划 stale？ 完成声明？ → 决定要不要问 Jev                  │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ 窄信号（stuck / planStale / completionSupported ...）
┌──────────────▼──────────────────────────────────────────────────────────────┐
│  决策提供方（默认 TypeSafe Jev，可替换）                                      │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ 确定性策略（src/core/policy.ts）
               ▼
        CONTINUE / REFLECT / REPLAN / VERIFY
```

**设计原则**：Jev 只回答"窄到不能再窄"的是/否/概率问题；阈值、冷却、频率上限、干预方式全部写在确定性代码里。每轮最多一次 Jev 请求，两次干预之间至少隔 `cooldownTurns` 轮，状态哈希去重避免重复提问。

## 快速开始

### 安装

```bash
npm install
npm run build
pi install .        # 或把仓库路径加进你的 pi 配置
```

### 模式

默认 `observe`（只记录评估、不打扰 Agent）。三种干预模式：

```bash
/adaptive-control mode observe   # 记录评估与干预事件，不注入建议
/adaptive-control mode assist    # 注入反思/重规划/验证建议（软干预）
/adaptive-control mode enforce   # 额外阻止未通过验证的 goal_control(action="complete")
```

### 配置

在项目下放 `.pi/adaptive-control.json`：

```json
{
  "mode": "assist",
  "model": "jev-latest",
  "timeoutMs": 2000,
  "cooldownTurns": 2,
  "thresholds": {
    "stuck": 0.8,
    "planStale": 0.8,
    "reflectionHelpful": 0.7,
    "completionSupported": 0.8
  }
}
```

完整字段见 `src/pi/config.ts`。

### Live Jev

设置 `TYPESAFE_API_KEY` 后运行可选的连通性测试：

```bash
npm run test:live
```

> 扩展只发送脱敏的边界状态，绝不持久化 API key 或完整请求体。

## Skills（可脱离扩展单独使用）

三个 Skill 遵循 Agent Skills 标准，加载后由模型按程序执行；若 `control_assess` 工具不可用，Skill 会退化为"手动执行同一套规则"并标注 **unassessed by a Decision Provider**：

- **adaptive-reflection** — 证据显示连续失败时，停下、换策略、最小化下一步；
- **adaptive-replan** — 计划无法解释新证据时，把既有步骤分为 keep / discard / revise，只补最小缺口；
- **adaptive-verification** — 完成声明必须有可检查证据支撑，禁止空口声称完成。

每个 Skill 都内置安全护栏：单次普通失败不足以重规划、禁止静默改写计划文件、禁止仅因加载了 Skill 就绕过用户约束。

## 开发与评估

```bash
npm run typecheck      # 类型检查
npm test               # 单元 + 集成测试（6 个）
npm run eval:fixtures  # 确定性策略 fixture 评测（5/5）
npm pack --dry-run     # 确认发布内容
```

`eval/cases.jsonl` 覆盖正常推进、连续失败、计划失效、完成证据不足、完成证据充分五类轨迹，用于回归验证策略行为。

## 路线图

- [ ] 基于 ≥30 条脱敏真实轨迹的精度/召回、漏干预/误干预评测
- [ ] off / observe / assist / enforce 四模式对比实验
- [ ] 更多决策提供方 adapter（本地模型、OpenAI 等）
- [ ] 与 pi-goal / pi-plan / pi-lens 的更深度协作

## 文档

- 完整技术设计：[TECHNICAL_DESIGN_v0.1.md](./TECHNICAL_DESIGN_v0.1.md)

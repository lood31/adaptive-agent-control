# Adaptive Agent Control

Pi Agent 的自适应控制平面：用 TypeSafe Jev 判断"该不该干预"，用确定性代码决定"怎么干预"。

v0.1 交付一个 Pi 扩展 + 三个可复用 Skill（`adaptive-reflection` / `adaptive-replan` / `adaptive-verification`）。

## 它管什么

Agent 长跑任务时常见三种翻车：

1. 同一个命令失败三次，Agent 换个姿势重试第四次，还是失败。
2. 目标和范围变了，手里的计划还是旧版，Agent 继续照旧执行。
3. 任务没做完，Agent 就调用 `goal_control(action="complete")` 声称完成。

前两种靠提示词救不回来（Agent 不知道自己正在绕圈），第三种靠提示词拦不住（它确实认为自己完成了）。所以"该不该干预"交给 Jev 这类 ~100ms 响应的 System One 模型，"干预后做什么"留在确定性代码里。

## Jev 用在哪

三个检查点，每个点向 Jev 发一组窄问题（`noul` 类型，返回 0–1 概率）。问题原文在 `src/providers/typesafe-jev.ts`：

```text
makingProgress:           Is the agent's recent work producing observable progress toward the stated objective?
stuck:                    Is the agent stuck in repeated low-yield work or recurring failures?
planStale:                Has new evidence invalidated an important assumption or sequence in the active plan?
reflectionLikelyHelpful:  Would explicitly examining assumptions likely change the next useful action?
completionSupported:      Does the available evidence support every stated success criterion for completion?
```

按检查点组合提问，概率过阈值才动作：

| 检查点 | 问什么 | 阈值 | 动作 |
| --- | --- | --- | --- |
| `reflection` | makingProgress + stuck + reflectionLikelyHelpful | stuck ≥ 0.8 且 reflectionLikelyHelpful ≥ 0.7 | 注入反思建议 |
| `replan` | makingProgress + stuck + planStale | planStale ≥ 0.8 | 建议重规划 |
| `completion` | completionSupported | completionSupported < 0.8 | `enforce` 下阻止完成 |

Jev 只回答窄问题，不做决策。阈值、冷却、干预方式全部写死在 `src/core/policy.ts`，想调行为改代码和配置，不靠改提示词。

一次调用约 100ms。默认 2 秒超时、0 次重试：Jev 超时或报错时 fail-open 放行并记录，外部服务挂了不会锁死 Agent。

### 换掉 Jev

Jev 只是默认提供方。实现 `DecisionProvider` 接口（`assess(check, state, signal)` 返回信号集）就能换成任何模型，`.pi/adaptive-control.json` 的 `provider` 字段负责切换。内置 adapter 在 `src/providers/typesafe-jev.ts`，本地 mock 直接 `"provider": "mock"`。

## 防抖与隐私

- 每轮最多 1 次 Jev 请求，状态哈希去重，同一状态不重复提问；
- 两次干预之间至少隔 `cooldownTurns`（默认 2）轮；
- 发给 Jev 的状态先脱敏（`src/core/redaction.ts`）：只有边界元数据、截断片段、失败指纹，没有文件内容、diff、凭据、token 或原始请求体；
- API key 只从环境变量 `TYPESAFE_API_KEY` 读取，不持久化。

## 安装与使用

```bash
npm install
npm run build
pi install .
```

默认 `observe`（只记录评估，不打扰 Agent）：

```bash
/adaptive-control mode observe   # 记录评估与干预事件，不注入建议
/adaptive-control mode assist    # 注入反思/重规划/验证建议
/adaptive-control mode enforce   # 额外阻止未通过验证的 goal_control(action="complete")
```

配置放在项目 `.pi/adaptive-control.json`：

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

完整字段见 `src/pi/config.ts`。设置 `TYPESAFE_API_KEY` 后跑 `npm run test:live` 验证连通性。

## 三个 Skill

遵循 Agent Skills 标准，可脱离扩展单独加载。`control_assess` 工具不可用时，Skill 退化为手动执行同一套规则，并标注 **unassessed by a Decision Provider**：

- **adaptive-reflection**：证据显示连续失败时，停下来检查假设，换一个下一步动作；
- **adaptive-replan**：计划解释不了新证据时，把既有步骤分为 keep / discard / revise，只补最小缺口；
- **adaptive-verification**：完成声明必须有可检查的证据，禁止空口声称完成。

护栏写死在 Skill 文档里：单次普通失败不足以重规划、禁止静默改写计划文件、禁止仅因加载了 Skill 就绕过用户约束。

## 开发与评估

```bash
npm run typecheck      # 类型检查
npm test               # 单元 + 集成测试（6 个）
npm run eval:fixtures  # 确定性策略 fixture 评测（5/5）
npm pack --dry-run     # 确认发布内容
```

`eval/cases.jsonl` 覆盖正常推进、连续失败、计划失效、完成证据不足、完成证据充分五类轨迹，回归验证策略行为。

## 路线图

- [ ] 基于 ≥30 条脱敏真实轨迹的精度/召回、漏干预/误干预评测
- [ ] off / observe / assist / enforce 四模式对比实验
- [ ] 更多决策提供方 adapter（本地模型、OpenAI 等）
- [ ] 与 pi-goal / pi-plan / pi-lens 的更深度协作

完整技术设计：[TECHNICAL_DESIGN_v0.1.md](./TECHNICAL_DESIGN_v0.1.md)

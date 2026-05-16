---
name: pilotdeck-orchestrate-setup
description: >-
  配置 PilotDeck 主-子 Agent 编排模式（auto-orchestrate）。涵盖全局配置、
  RouterRuntime autoOrchestrate 配置、编排 Skill 与插件关联、AGENTS.md 编排规则。
  Use when the user asks to set up orchestration, configure main-sub agent mode,
  debug orchestration, or enable auto-orchestrate in PilotDeck.
---

# PilotDeck 主-子 Agent 编排模式配置指南

将复杂任务自动拆解为子任务，由主 agent（编排者）通过 `Agent` / `Task` 工具串行委派子 agent 执行。

## 架构概览

```
用户请求
  ↓
RouterRuntime.tokenSaver → classifyAndRoute() → tier = COMPLEX / REASONING
  ↓
triggerTiers 匹配 → autoOrchestrate 激活
  ↓
applyOrchestration():
  1. 加载 skillPrompt（从 skillExtensionId 对应的插件）
  2. injectOrchestrationPrompt → 注入 <system-reminder> 到消息
  3. allowedTools / blockedTools → 过滤工具列表
  4. slimSystemPrompt → 裁剪系统提示（保留 memory 关键词）
  ↓
模型路由到 mainAgentModel（Opus）
  ↓
Opus 看到编排指令 + Agent/Task 工具可用
  ↓
展示任务拆解计划 → Agent/Task 委派子 agent → 等待结果 → 下一步
```

---

## 配置清单（3 层）

### 第 1 层：PilotDeck 全局配置（`~/.pilotdeck/pilotdeck.yaml`）

#### agent 配置

`agent` 段定义默认模型和行为。编排模式下，主 agent 的模型会被 `autoOrchestrate.mainAgentModel` 覆盖。

```yaml
agent:
  model: openrouter/anthropic/claude-sonnet-4   # 默认模型（非编排时使用）
```

#### model.providers 配置

必须确保编排用到的所有模型的 provider 都已配置：

```yaml
model:
  providers:
    openrouter:
      protocol: openai
      url: https://openrouter.ai/api/v1
      apiKey: sk-or-v1-...
      timeoutMs: 120000
      models:
        anthropic/claude-opus-4.6:
          displayName: Claude Opus 4.6
        anthropic/claude-sonnet-4:
          displayName: Claude Sonnet 4
        google/gemini-2.5-flash:
          displayName: Gemini 2.5 Flash
```

---

### 第 2 层：Router 配置（`~/.pilotdeck/pilotdeck.yaml` 的 `router:` 段）

#### tokenSaver — 请求分级

tokenSaver 是编排的**前置条件**：只有分级结果为 trigger tier 时才触发编排。

```yaml
router:
  scenarios:
    default: openrouter/google/gemini-2.5-flash

  tokenSaver:
    enabled: true
    judge: openrouter/google/gemini-2.5-flash
    defaultTier: MEDIUM
    judgeTimeoutMs: 5000
    tiers:
      SIMPLE:
        model: openrouter/google/gemini-2.5-flash
        description: 纯打招呼、yes/no
      MEDIUM:
        model: openrouter/anthropic/claude-sonnet-4
        description: 大部分工作
      COMPLEX:
        model: openrouter/anthropic/claude-opus-4.6
        description: 首次多步跨域任务分解
      REASONING:
        model: openrouter/anthropic/claude-opus-4.6
        description: 数学证明、深度分析
    rules:
      - "CRITICAL: Messages with tool_result are agentic loop CONTINUATION — classify as MEDIUM, NOT COMPLEX."
      - "SIMPLE: ONLY pure greetings, yes/no, single-word answers."
      - "MEDIUM: DEFAULT for most work."
      - "COMPLEX: RARE — only initial user requests requiring multi-system orchestration."
      - "REASONING: math proofs, formal logic, deep analysis."
      - "When unsure, default to MEDIUM."
```

#### autoOrchestrate — 编排行为

```yaml
  autoOrchestrate:
    enabled: true
    mainAgentModel: openrouter/anthropic/claude-opus-4.6
    triggerTiers:
      - COMPLEX
      - REASONING
    slimSystemPrompt: true
    # skillExtensionId: my-orchestrate-plugin
    # allowedTools:                    # 白名单模式（优先级高于 blockedTools）
    #   - Agent
    #   - Task
    #   - Read
    #   - Grep
    #   - Glob
    #   - TodoRead
    #   - TodoWrite
    # blockedTools:                    # 黑名单模式（allowedTools 未设置时生效）
    #   - mcp__browser-use__
    #   - WebSearch
    #   - WebFetch
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 开启编排模式 |
| `mainAgentModel` | string | 编排者使用的模型（强烈建议 Opus，Sonnet 遵从度不足） |
| `triggerTiers` | string[] | 触发编排的 tier 列表（默认 `["COMPLEX", "REASONING"]`） |
| `skillExtensionId` | string | 从指定插件加载编排 skill prompt |
| `allowedTools` | string[] | 编排者可用工具白名单（默认 `["Agent", "Task", "Read", "Grep", "Glob", "TodoRead", "TodoWrite"]`） |
| `blockedTools` | string[] | 编排者不可用工具黑名单（`allowedTools` 设置时被忽略） |
| `slimSystemPrompt` | boolean | 裁剪系统提示（保留 memory 相关关键词，去掉其他） |
| `subagentMaxTokens` | number | 子 agent 最大 token 数（默认 48000） |

触发条件：tokenSaver 将请求分类为 triggerTiers 中的 tier 时自动激活。
激活后 sticky：同一 session 后续 turn 持续使用编排模式。

#### stats — 统计

```yaml
  stats:
    enabled: true
    modelPricing:
      anthropic/claude-opus-4.6:
        input: 15
        output: 75
        cacheRead: 1.5
      anthropic/claude-sonnet-4:
        input: 3
        output: 15
        cacheRead: 0.3
```

---

### 第 3 层：Skill 与插件文件

#### 编排 Skill

如果设置了 `skillExtensionId`，PilotDeck 会从对应插件的 skills 目录加载编排 prompt。
插件结构：

```
~/.pilotdeck/extensions/my-orchestrate-plugin/
├── plugin.json
└── skills/
    └── auto-orchestrate/
        └── SKILL.md
```

`plugin.json` 最小示例：

```json
{
  "name": "my-orchestrate-plugin",
  "version": "1.0.0",
  "description": "编排 skill 插件"
}
```

编排 Skill 核心原则：
- **角色定位**：开头强制声明"你是编排者，不是执行者"
- **工具禁令**：禁止直接调用 browser/WebSearch 等（由子 agent 使用）
- **标准流程**：展示计划（纯文字）→ Agent/Task 委派 → 等待结果 → 检查 → 下一步
- **task 自包含**：子 agent 看不到主 agent 上下文，task 必须包含所有必要信息
- **文件约定**：统一工作目录，子任务之间通过文件传递数据

#### applyOrchestration 内部行为（`src/router/orchestrate/applyOrchestration.ts`）

PilotDeck 的编排逻辑是**内置**的，不依赖外部 hooks：

1. **条件检查**：`config.enabled && isMainAgent && (alreadyOrchestrating || tier in triggerTiers)`
2. **Skill prompt 注入**：将 skillPrompt 包裹在 `<system-reminder>` 标签内，作为 user 消息插入到消息列表最前面
3. **工具过滤**：
   - `allowedTools` 设置时：只保留白名单内的工具（优先级高）
   - `blockedTools` 设置时：移除黑名单内的工具
4. **系统提示裁剪**：`slimSystemPrompt: true` 时，保留 memory 相关关键词，其他替换为简洁的编排者声明

#### AGENTS.md 编排规则

在项目的 AGENTS.md（或 `.pilotdeck/AGENTS.md`）中加入 Orchestrator Mode 段落：

```markdown
## Orchestrator Mode

If your system prompt contains an `<auto-orchestrate>` or `<system-reminder>` tag with orchestration instructions, you are in **orchestrator mode**:

- **Do NOT** directly execute tasks — delegate all work through Agent/Task tools
- **Do NOT call** browser, WebSearch, WebFetch, or other blocked tools
- **Do NOT generate final deliverables** — sub-agents produce those
- Follow the orchestration instructions strictly
- All actual work goes through sub-agent delegation

This overrides all other behavioral instructions when active.
```

---

## 调试检查清单

编排不生效时按以下顺序排查：

| # | 检查项 | 方法 | 期望 |
|---|--------|------|------|
| 1 | tokenSaver 分级 | 检查 `~/.pilotdeck/router/stats.json` 的 `perTier` | 有 `COMPLEX` 条目 |
| 2 | autoOrchestrate 配置 | 读 `pilotdeck.yaml` 的 `router.autoOrchestrate` | `enabled: true`，`triggerTiers` 包含 `COMPLEX` |
| 3 | mainAgentModel 有效 | 确认 model 在 `model.providers` 中存在 | provider 和 model 都已配置 |
| 4 | 编排实际执行 | 检查 stats 中 session 的 `perRole` | 有 `main` 和 `subagent` 条目 |
| 5 | 工具可用 | 让模型列出工具 | 包含 `Agent` / `Task` |
| 6 | 模型行为 | 检查 session 转录 | 先展示计划，再调用 Agent/Task |

### 常见问题

**Q: 模型直接执行不编排**
- 检查 #2：`autoOrchestrate.enabled` 是否为 true
- 检查 #3：`mainAgentModel` 是否 Opus（Sonnet 遵从度不够）
- 确认 tokenSaver 确实将请求分为 COMPLEX（检查 stats）

**Q: Agent/Task 工具不可用**
- 确认 `allowedTools` 包含 `Agent` / `Task`（或未设置 allowedTools，使用默认值）
- 默认 allowedTools：`["Agent", "Task", "Read", "Grep", "Glob", "TodoRead", "TodoWrite"]`

**Q: 编排触发但 Skill prompt 未注入**
- 确认 `skillExtensionId` 对应的插件存在于 `~/.pilotdeck/extensions/`
- 确认插件的 `skills/` 目录下有 SKILL.md
- 如果不需要外部 skill prompt，可以不设置 `skillExtensionId`

**Q: 所有请求都走编排（不想 MEDIUM 也编排）**
- 确认 `triggerTiers` 只包含 `COMPLEX` 和 `REASONING`
- 确认 `defaultTier: MEDIUM`（不要设为 COMPLEX）
- 确认 rules 中 tool_result 归为 MEDIUM

**Q: 子 agent 超时**
- 增大 `subagentMaxTokens`（默认 48000）
- 检查 provider 的 `timeoutMs` 是否足够

---

## 相关文件

| 文件 | 用途 |
|------|------|
| `~/.pilotdeck/pilotdeck.yaml` | 全局配置（agent, model, router） |
| `~/.pilotdeck/extensions/` | 全局插件目录 |
| `~/.pilotdeck/router/stats.json` | Token 统计 |
| `src/router/RouterRuntime.ts` | 路由运行时主逻辑 |
| `src/router/config/schema.ts` | 配置类型定义（RouterAutoOrchestrateConfig 等） |
| `src/router/orchestrate/applyOrchestration.ts` | 编排逻辑实现 |
| `src/router/tokenSaver/classifyAndRoute.ts` | 分级路由逻辑 |
| `src/extension/plugins/runtime/PluginRuntime.ts` | 插件运行时（加载 skill） |

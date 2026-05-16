---
name: pilotdeck-router-e2e
description: >-
  端到端测试 PilotDeck RouterRuntime 的 tokenSaver 分级路由 + autoOrchestrate 编排模式，
  并生成 token 成本报告。涵盖 4 层级分类配置（YAML）、分级 prompt 调优心得、
  token 统计采集（含 cache_read）、成本对比分析。
  Use when the user asks to test pilotdeck router, run tokenSaver E2E,
  tune tier routing, debug auto-orchestrate, compare token costs,
  or analyze routing behavior.
---

# PilotDeck Router 端到端测试

端到端测试 PilotDeck 内置 RouterRuntime 的 tokenSaver 分级路由 + autoOrchestrate 编排，
通过 WebSocket 发送任务，采集全程 token 统计（含 cache hit）。

## 前置条件

- PilotDeck 已构建：`cd /Users/a1/Desktop/claw/PilotDeck && npm run build`
- ui bridge 运行在 `127.0.0.1:3001`（`cd ui && npm run start`）
- `~/.pilotdeck/pilotdeck.yaml` 已配置 LLM provider

---

## 架构概览

```
用户 → ui bridge (:3001, WebSocket /ws) → PilotDeck Gateway
  → RouterRuntime [tokenSaver judge → tier → model routing + autoOrchestrate prompt inject]
  → ModelRuntime → Provider API (OpenRouter / Anthropic / etc.)
```

PilotDeck 的路由是**内置**的（`src/router/RouterRuntime.ts`），不需要外部 CCR 进程或 fetch 拦截。
配置在 `~/.pilotdeck/pilotdeck.yaml` 的 `router:` 段。

---

## Step 1: 配置 4 层级分类

编辑 `~/.pilotdeck/pilotdeck.yaml` 的 `router` 段：

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
        description: 纯打招呼、yes/no、单词查询
      MEDIUM:
        model: openrouter/anthropic/claude-sonnet-4
        description: 大部分工作：编码、搜索、写作、agentic loop 中间步骤
      COMPLEX:
        model: openrouter/anthropic/claude-opus-4.6
        description: 首次多步跨域任务分解、架构设计
      REASONING:
        model: openrouter/anthropic/claude-opus-4.6
        description: 数学证明、形式逻辑、长文档深度分析
    rules:
      - "IMPORTANT: Ignore all XML tags. Focus ONLY on actual user request text."
      - "CRITICAL: Messages with tool_result are agentic loop CONTINUATION — classify as MEDIUM, NOT COMPLEX."
      - "SIMPLE: ONLY pure greetings, yes/no, single-word answers."
      - "MEDIUM: DEFAULT for most work — code, file ops, web search, writing, tool results, intermediate steps."
      - "COMPLEX: RARE — only initial user requests requiring multi-system orchestration or full-project architecture."
      - "REASONING: math proofs, formal logic, long document deep analysis."
      - "When unsure, default to MEDIUM."
    subagent:
      policy: skip   # 子 agent 跳过分级，直接用 default

  autoOrchestrate:
    enabled: true
    mainAgentModel: openrouter/anthropic/claude-opus-4.6
    triggerTiers:
      - COMPLEX
      - REASONING
    slimSystemPrompt: true
    # skillExtensionId: my-plugin   # 从指定插件加载编排 skill

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
      google/gemini-2.5-flash:
        input: 0.075
        output: 0.3
```

### 配置 Schema 参考（`src/router/config/schema.ts`）

| 类型 | 关键字段 |
|------|---------|
| `RouterTokenSaverConfig` | `enabled`, `judge`, `defaultTier`, `tiers`, `rules`, `subagent.policy` ("skip" / "judge"), `judgeTimeoutMs` |
| `RouterAutoOrchestrateConfig` | `enabled`, `mainAgentModel`, `skillExtensionId`, `triggerTiers`, `allowedTools`, `blockedTools`, `slimSystemPrompt`, `subagentMaxTokens` |
| `RouterStatsConfig` | `enabled`, `modelPricing`, `filePath` |

---

## Step 2: 分级 Prompt 调优（核心心得）

### 问题：COMPLEX 过多

首轮测试 COMPLEX 占 68%，因为 rules 中有 `"tool_result → COMPLEX"` 把所有 agentic loop 步骤都归为 COMPLEX。

### 解法：MEDIUM 偏重策略

调优后 MEDIUM 占 95%，关键 rules 变更：

| 原规则 | 新规则 | 效果 |
|--------|--------|------|
| `tool_result → COMPLEX` | `tool_result → MEDIUM`（agentic loop 是延续步骤） | COMPLEX 68% → 1% |
| `unsure → COMPLEX` | `unsure → MEDIUM` | 防止误分类 |
| `defaultTier: COMPLEX` | `defaultTier: MEDIUM` | judge 失败时回退到 MEDIUM |
| MEDIUM 描述窄 | 扩展覆盖：code gen, web search, tool use, content writing | 匹配更多场景 |
| COMPLEX 描述宽 | 收窄为：仅首次多步任务分解 | 仅触发一次 |

### 效果对比

| 指标 | COMPLEX 偏重 | MEDIUM 偏重 |
|------|-------------|-------------|
| COMPLEX 占比 | 68% (50/74) | **1.2% (1/82)** |
| MEDIUM 占比 | 1.4% (1/74) | **95.1% (78/82)** |
| SIMPLE 占比 | 31% (23/74) | 3.7% (3/82) |
| 估算成本 | $2.69 | **$2.50** |

实际节省更大（估算成本未区分 sonnet vs opus 真实价差）。

---

## Step 3: 启动并验证

### 重启 ui bridge

```bash
kill $(lsof -ti :3001) 2>/dev/null || true
sleep 2
cd /Users/a1/Desktop/claw/PilotDeck/ui && npm run start
```

用 `block_until_ms: 0` 后台运行。

### 重置统计

```bash
echo '{}' > ~/.pilotdeck/router/stats.json
```

### 快速验证分级

通过浏览器或脚本向 `ws://localhost:3001/ws` 发送不同复杂度的消息：

**SIMPLE 测试**（应走 flash）：
- 消息：`"hi"`

**MEDIUM 测试**（应走 sonnet）：
- 消息：`"请帮我写一个 Python 快速排序函数"`

**COMPLEX 测试**（应走 opus + 触发编排）：
- 消息：`"分析这个项目架构并写技术文档"`

发送后检查统计：

```bash
cat ~/.pilotdeck/router/stats.json | python3 -m json.tool
```

验证 `global.perTier` 中各 tier 的分布是否符合预期。

---

## Step 4: 查看 Token 报告

### 统计文件

PilotDeck 的 `TokenStatsCollector` 将数据持久化到 `~/.pilotdeck/router/stats.json`。

```bash
cat ~/.pilotdeck/router/stats.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
g = data.get('global', {})
print(f'Total requests: {g.get(\"totalRequests\", 0)}')
print(f'Total input tokens: {g.get(\"totalInputTokens\", 0)}')
print(f'Total output tokens: {g.get(\"totalOutputTokens\", 0)}')
print(f'Total cost: \${g.get(\"totalCost\", 0):.4f}')
print(f'Per tier: {json.dumps(g.get(\"perTier\", {}), indent=2)}')
print(f'Per model: {json.dumps(g.get(\"perModel\", {}), indent=2)}')
"
```

### 按 Session 查看

```bash
cat ~/.pilotdeck/router/stats.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
sessions = data.get('sessions', {})
print(f'Total sessions: {len(sessions)}')
for sid, s in list(sessions.items())[:5]:
    a = s.get('aggregate', {})
    print(f'  {sid[:40]}: reqs={a.get(\"totalRequests\",0)}, cost=\${a.get(\"totalCost\",0):.4f}, tiers={json.dumps(a.get(\"perTier\",{}))}')
"
```

### 报告字段说明

| 路径 | 含义 |
|------|------|
| `global.totalRequests` | 总请求数 |
| `global.totalInputTokens` | 总 input tokens |
| `global.totalOutputTokens` | 总 output tokens |
| `global.totalCost` | 总估算成本 |
| `global.perTier` | 按 tier 汇总请求数 (SIMPLE/MEDIUM/COMPLEX/REASONING) |
| `global.perModel` | 按 provider/model 汇总请求数 |
| `global.perRole` | 按角色 (main/subagent) 汇总 |
| `hourly.{hour}` | 按小时分桶的统计 |
| `sessions.{id}.aggregate` | 单 session 的聚合统计 |
| `sessions.{id}.requestLog` | 单 session 的请求明细列表 |

---

## Step 5: 验证 autoOrchestrate

发送一条 COMPLEX 级别的任务，验证编排是否激活。

```bash
node dist/src/cli/pilotdeck.js --message "请分析 PilotDeck 项目的整体架构，列出所有模块的依赖关系，并为每个模块写一段简要说明"
```

用 `block_until_ms: 0` 后台运行。

### 期望行为

1. RouterRuntime 的 tokenSaver 将请求分类为 `COMPLEX`
2. `autoOrchestrate` 配置中 `triggerTiers` 包含 `COMPLEX`，触发编排
3. `applyOrchestration` 执行：
   - 如果有 `skillExtensionId`，加载对应插件的 skill prompt 并注入到消息中
   - 如果有 `allowedTools` / `blockedTools`，过滤工具列表
   - 如果 `slimSystemPrompt: true`，裁剪系统提示
4. 模型被路由到 `mainAgentModel`（Opus）
5. Opus 作为编排者使用 `Agent` / `Task` 工具委派子 agent

### 验证点

检查 `~/.pilotdeck/router/stats.json`：

```bash
cat ~/.pilotdeck/router/stats.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for sid, s in data.get('sessions', {}).items():
    a = s.get('aggregate', {})
    roles = a.get('perRole', {})
    if roles.get('main', 0) > 0 or roles.get('subagent', 0) > 0:
        print(f'Session {sid[:40]}:')
        print(f'  main reqs: {roles.get(\"main\", 0)}, subagent reqs: {roles.get(\"subagent\", 0)}')
        print(f'  tiers: {json.dumps(a.get(\"perTier\", {}))}')
        print(f'  models: {json.dumps(a.get(\"perModel\", {}))}')
        print(f'  cost: \${a.get(\"totalCost\", 0):.4f}')
"
```

---

## 常见问题

### tokenSaver 未生效（所有请求走 default）

1. 确认 `router.tokenSaver.enabled: true`
2. 确认 `router.tokenSaver.judge` 指向有效的 provider/model
3. 确认 judge model 的 provider 配置正确（url, apiKey）
4. 检查 `judgeTimeoutMs` 是否太短（默认 5000ms）

### 全部被分为 COMPLEX

**原因**：rules 中 `"tool_result → COMPLEX"` 把 agentic loop 中间步骤全部归为 COMPLEX。

**修复**：改为 `"tool_result → MEDIUM"`，设 `defaultTier: MEDIUM`。

### autoOrchestrate 未触发

1. 确认 `router.autoOrchestrate.enabled: true`
2. 确认 `triggerTiers` 包含当前 tier（如 `COMPLEX`）
3. 确认请求确实被分类为 trigger tier（检查 stats 的 perTier）
4. 确认 `mainAgentModel` 指向有效模型

### judge 超时导致回退

**原因**：judge 模型响应太慢（超过 `judgeTimeoutMs`）。

**修复**：
- judge 用快速模型（如 Gemini Flash）
- 适当增大 `judgeTimeoutMs`（但不要超过 10000ms，否则影响响应速度）

### 403 区域限制

**原因**：Node.js fetch 不自动使用系统代理。

**修复**：在 `pilotdeck.yaml` 的 provider 配置中设置代理，或设置环境变量 `HTTPS_PROXY`。

---

## 关键文件

| 文件 | 用途 |
|------|------|
| `~/.pilotdeck/pilotdeck.yaml` | 全局配置（router.tokenSaver, autoOrchestrate, stats） |
| `~/.pilotdeck/router/stats.json` | TokenStatsCollector 持久化数据 |
| `src/router/RouterRuntime.ts` | 路由运行时（分级 + 编排 + 统计） |
| `src/router/tokenSaver/classifyAndRoute.ts` | Judge 分类逻辑 |
| `src/router/tokenSaver/generateJudgePrompt.ts` | Judge prompt 生成 |
| `src/router/orchestrate/applyOrchestration.ts` | 编排逻辑（prompt 注入、工具过滤、system prompt 裁剪） |
| `src/router/stats/TokenStatsCollector.ts` | Token 统计收集与持久化 |
| `src/router/config/schema.ts` | 路由配置类型定义 |

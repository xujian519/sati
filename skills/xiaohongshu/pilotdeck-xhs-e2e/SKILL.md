---
name: pilotdeck-xhs-e2e
description: >-
  端到端测试 PilotDeck 小红书全链路编排模式。验证 tokenSaver 分级 + autoOrchestrate
  编排触发、DEFAULT_ORCHESTRATION_PROMPT 注入、子 agent 委派、token 统计采集。
  Use when the user asks to test PilotDeck orchestration, run XHS E2E test,
  verify autoOrchestrate, or analyze PilotDeck routing behavior.
---

# PilotDeck 小红书编排模式 E2E 测试

端到端测试 PilotDeck 的 tokenSaver 分级 + autoOrchestrate 编排，
通过 WebSocket 发送复杂任务，验证主 agent 以编排模式运行并委派子 agent。

## 前置条件

- PilotDeck 最新代码已拉取（含 `DEFAULT_ORCHESTRATION_PROMPT`）
- Node.js >= 22（内置 WebSocket）
- `~/.pilotdeck/pilotdeck.yaml` 中 `router.autoOrchestrate.enabled: true`

---

## 架构概览

```
测试脚本 (WS client)
  → PilotDeck Gateway (:18789/ws)
    → Router: tokenSaver judge → tier=complex → autoOrchestrate
      → 注入 DEFAULT_ORCHESTRATION_PROMPT
      → 工具白名单: agent / read_file / grep / glob
      → 系统 prompt slim
    → 主 Agent（编排模式）
      → agent tool → 子 Agent 1: 搜索素材
      → agent tool → 子 Agent 2: 生成头图
      → agent tool → 子 Agent 3: 撰写文案
      → agent tool → 子 Agent 4: 登录 + 发布
    → turn_completed
  → 读取 ~/.pilotdeck/router/stats.json 生成报告
```

---

## Step 1: 重启 Gateway（加载最新代码）

```bash
lsof -ti :18789 2>/dev/null | xargs kill 2>/dev/null
sleep 2
cd /Users/a1/Desktop/claw/PilotDeck
mkdir -p ./logs
nohup bash -c 'PILOTDECK_PROXY=http://127.0.0.1:7890 npx tsx src/cli/pilotdeck.ts server --port 18789' \
  > ./logs/pilotdeck-gateway.log 2>&1 &
sleep 5
lsof -i :18789 2>/dev/null | head -3   # 确认端口
```

验证启动日志：

```bash
head -5 ./logs/pilotdeck-gateway.log
# 期望: PilotDeck server listening: http://127.0.0.1:18789
```

## Step 2: 重置 Stats

```bash
echo '{}' > ~/.pilotdeck/router/stats.json
```

## Step 3: 运行测试脚本

```bash
node ~/.pilotdeck/skills/pilotdeck-xhs-e2e/test-orchestrate.mjs
```

测试 query：`帮我看一下马斯克相关的最新的 Xpost，做成小红书头图和笔记发`

脚本超时 10 分钟，自动终止。

## Step 4: 验证编排触发

检查 gateway 日志：

```bash
grep "autoOrch" ./logs/pilotdeck-gateway.log | tail -10
```

期望日志：

```
[autoOrch] input: tier=complex, isMain=true, alreadyOrch=false, triggerTiers=complex
[autoOrch] orchestration applied: promptInjected=true, toolsStripped=true, sysPromptSlim=true
```

如果看到 `tier "xxx" not in triggerTiers, skipping`，说明 judge 未将 query 分类为 `complex`。

## Step 5: 监控子 Agent

测试脚本实时打印事件，观察是否有 `agent` 工具调用：

```
[tool_call_started] agent — "搜索马斯克最新 Xpost"
[tool_call_finished] agent — ok=true
[tool_call_started] agent — "生成小红书头图"
...
```

## Step 6: 采集 Stats 报告

测试完成后脚本自动输出，或手动查看：

```bash
cat ~/.pilotdeck/router/stats.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
g = d.get('global', {})
print('=== PilotDeck Orchestration E2E Stats ===')
print(f'Total requests: {g.get(\"totalRequests\", 0)}')
print(f'Total input tokens: {g.get(\"totalInputTokens\", 0)}')
print(f'Total output tokens: {g.get(\"totalOutputTokens\", 0)}')
print(f'Total cost: \${g.get(\"totalCost\", 0):.4f}')
print()
print('Per tier:')
for k, v in g.get('perTier', {}).items():
    print(f'  {k}: {v}')
print()
print('Per role:')
for k, v in g.get('perRole', {}).items():
    print(f'  {k}: {v}')
print()
print('Per model:')
for k, v in g.get('perModel', {}).items():
    print(f'  {k}: {v}')
"
```

期望：`perTier` 中出现 `complex`，`perRole` 中 `main` 和 `subagent` 都有计数。

---

## 常见问题

### 编排未触发（tier 不是 complex）

**最可能原因**：judge 模型将 query 分类为 `reasoning` 而非 `complex`。

**诊断**：

```bash
grep "token-saver.*Judge" ./logs/pilotdeck-gateway.log | tail -5
# 查看 judge 返回的 <tier>xxx</tier>
```

**修复**：在 `pilotdeck.yaml` 的 `tokenSaver.rules` 中添加针对性规则：

```yaml
rules:
  - "Tasks involving multiple domains (web scraping + image generation + social media publishing) require sub-agent orchestration — classify as complex"
```

或扩大 `triggerTiers` 包含 `reasoning`：

```yaml
autoOrchestrate:
  triggerTiers: [complex, reasoning]
```

### 子 Agent 超时

**根因**：默认 `subagentMaxTokens` 为 48000，浏览器操作可能需要更多轮次。

**修复**：在 `pilotdeck.yaml` 的 `autoOrchestrate` 中增大：

```yaml
autoOrchestrate:
  subagentMaxTokens: 96000
```

### 子 Agent 工具权限被拒

**根因**：`mode: "bypassPermissions"` 仅影响主 agent，子 agent 可能仍需权限。

**修复**：确保 `pilotdeck.yaml` 中工具权限正确配置。

### Gateway 连接失败

**诊断**：

```bash
curl -s http://127.0.0.1:18789/health
# 期望: {"ok":true}
```

---

## 实测结果（2026-05-14）

测试 query: `帮我看一下马斯克相关的最新的 Xpost，做成小红书头图和笔记发`

| 指标 | 值 |
|------|-----|
| Total requests | 33 |
| complex tier (主 agent) | 3 |
| subagent calls | 30 |
| Total input tokens | 495,657 |
| Total output tokens | 7,097 |
| Total cost | $0.0604 |
| 耗时 | ~10 min (timeout) |

### 关键发现

1. **judge 分类**：默认 rules 下 judge 将此 query 分类为 `reasoning`，需要显式添加规则识别跨域多技能任务为 `complex`。
2. **编排触发**：rules 调优后，`complex` tier 正确触发，`DEFAULT_ORCHESTRATION_PROMPT` 注入成功。
3. **子 agent 执行**：主 agent 正确使用 `agent` 工具委派任务，子 agent 使用 `web_search` 和 `web_fetch` 搜索信息。
4. **子 agent 产出问题**：子 agent 未将结果写入 `DEFAULT_ORCHESTRATION_PROMPT` 指定的 `/tmp_workspace/` 路径，导致主 agent 重新委派。

### 推荐 tokenSaver rules（已验证有效）

```yaml
rules:
  - "complex: tasks that span MULTIPLE DISTINCT DOMAINS requiring different specialized tools"
  - "complex: any task mentioning 小红书/XHS publishing, header image generation, or multi-platform content creation"
  - "reasoning: deep single-agent work within ONE domain"
  - "medium: single tool call, short text generation, agentic loop continuation"
  - "simple: trivial greetings, confirmations"
  - "When unsure between complex and reasoning, choose complex if the task involves 3+ different tool types"
```

---

## 关键文件

| 文件 | 用途 |
|------|------|
| `~/.pilotdeck/pilotdeck.yaml` | 主配置（autoOrchestrate、tokenSaver） |
| `~/.pilotdeck/router/stats.json` | Token 统计持久化 |
| `~/.pilotdeck/server-token` | Gateway 认证 token |
| `PilotDeck/src/router/config/schema.ts` | DEFAULT_ORCHESTRATION_PROMPT |
| `PilotDeck/src/router/orchestrate/applyOrchestration.ts` | 编排注入逻辑 |
| `PilotDeck/src/router/RouterRuntime.ts` | 核心路由决策 |
| `./logs/pilotdeck-gateway.log` | Gateway 运行日志 |

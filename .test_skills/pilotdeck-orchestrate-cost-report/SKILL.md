---
name: pilotdeck-orchestrate-cost-report
description: >-
  端到端测试 PilotDeck 主-子 Agent 编排模式并生成成本对比报告。
  涵盖网关重启、测试请求发送、子 agent 监控、token 统计收集、
  成本对比（混合路由 vs 全 Opus vs 单体 Opus）。
  Use when the user asks to test orchestration, run E2E orchestrate test,
  compare token costs, debug sub-agent issues, or analyze orchestration savings.
---

# PilotDeck 编排模式 E2E 测试与成本对比

端到端测试主—子 agent 编排，收集 token 数据，生成成本对比报告。

前置条件：已按 `pilotdeck-orchestrate-setup` skill 完成配置。

---

## Step 1: 重启 ui bridge 加载最新配置

```bash
kill $(lsof -ti :3001) 2>/dev/null || true
sleep 2
echo '{}' > ~/.pilotdeck/router/stats.json   # 重置统计
cd /Users/a1/Desktop/claw/PilotDeck/ui && npm run start
```

用 `block_until_ms: 0` 后台运行，等待 10 秒后确认启动成功。

验证配置加载：

```bash
curl -s http://localhost:3001/api/health
```

## Step 2: 发送测试请求

通过 CLI 发送一个复杂任务（会触发 COMPLEX 分级 → autoOrchestrate）：

```bash
cd /Users/a1/Desktop/claw/PilotDeck
node dist/src/cli/pilotdeck.js --message "<测试任务描述>" &
```

用 `block_until_ms: 0` 后台运行，因为编排任务可能持续 5-15 分钟。

测试任务示例：
- "分析 PilotDeck 项目架构，为 router、gateway、extension 三个模块分别写技术文档"
- "搜索最新的 Node.js 22 性能优化实践，写一份调研报告"
- "重构 src/router/ 目录下的测试文件，确保覆盖率达到 90%"

## Step 3: 验证编排激活

检查 `~/.pilotdeck/router/stats.json`：

```bash
cat ~/.pilotdeck/router/stats.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
g = data.get('global', {})
print(f'Total requests: {g.get(\"totalRequests\", 0)}')
print(f'Per tier: {json.dumps(g.get(\"perTier\", {}), indent=2)}')
print(f'Per role: {json.dumps(g.get(\"perRole\", {}), indent=2)}')
print(f'Per model: {json.dumps(g.get(\"perModel\", {}), indent=2)}')
"
```

期望：
- `perTier` 中有 `COMPLEX` 条目（触发编排）
- `perRole` 中有 `main`（主 agent）和 `subagent`（子 agent）条目
- `perModel` 中 Opus 对应主 agent，Sonnet/Flash 对应子 agent

## Step 4: 监控子 agent 进度

### 查看 session 统计

```bash
cat ~/.pilotdeck/router/stats.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
sessions = data.get('sessions', {})
for sid, s in sorted(sessions.items(), key=lambda x: x[1]['aggregate']['totalRequests'], reverse=True)[:10]:
    a = s['aggregate']
    roles = a.get('perRole', {})
    tiers = a.get('perTier', {})
    print(f'{sid[:50]}:')
    print(f'  requests={a[\"totalRequests\"]}, cost=\${a[\"totalCost\"]:.4f}')
    print(f'  roles={json.dumps(roles)}, tiers={json.dumps(tiers)}')
    print(f'  input={a[\"totalInputTokens\"]}, output={a[\"totalOutputTokens\"]}')
    print()
"
```

### 区分主 agent 和子 agent

在 `router/stats.json` 的 `sessions` 中，每个 session 的 `requestLog` 条目有 `role` 字段：
- `role: "main"` → 主 agent（编排者）
- `role: "subagent"` → 子 agent（执行者）

## Step 5: 收集 token 统计

等待所有子 agent 完成后（CLI 返回），完整读取统计：

```bash
cat ~/.pilotdeck/router/stats.json | python3 -m json.tool
```

### 关键字段

| 路径 | 含义 |
|------|------|
| `global.totalRequests` | 总 LLM 请求数 |
| `global.totalInputTokens` | 总 input tokens（不含 cache） |
| `global.totalOutputTokens` | 总 output tokens |
| `global.totalCost` | 总估算成本 |
| `global.perTier` | 按 tier 分组的请求数 |
| `global.perRole` | 按 role (main/subagent) 分组的请求数 |
| `global.perModel` | 按 provider/model 分组的请求数 |
| `sessions.{id}.aggregate` | 单 session 聚合统计 |
| `sessions.{id}.requestLog[].cost` | 单次请求的成本明细（input, output, cacheRead, total） |
| `sessions.{id}.requestLog[].usage` | 单次请求的 token 用量 |

---

## Step 6: 生成成本对比报告

### 三种基准

| 方案 | 计算方法 |
|------|----------|
| A) 混合路由（实际） | 直接从 stats 读取 `totalCost` |
| B) 子 agent 重定价 Opus | 子 agent tokens × Opus 单价（假设不用便宜模型） |
| C) 单体 Opus（无隔离） | 模拟所有内容在一个上下文中累积 |

### 定价参考（$/百万 tokens）

| 模型 | Input | Output | Cache Read |
|------|-------|--------|------------|
| claude-opus-4.6 | 15 | 75 | 1.5 |
| claude-sonnet-4 | 3 | 15 | 0.3 |
| gpt-4o-mini | 0.15 | 0.6 | 0.075 |
| gemini-2.5-flash | 0.075 | 0.3 | 0.0075 |
| deepseek-v4 | 0.50 | 1.50 | — |

PilotDeck 的 `TokenStatsCollector` 内置了默认定价（`src/router/stats/TokenStatsCollector.ts` 中的 `DEFAULT_PRICING`），也可以在 `router.stats.modelPricing` 中自定义。

### 成本计算脚本

```bash
cat ~/.pilotdeck/router/stats.json | python3 -c "
import json, sys

OPUS_PRICING = {'input': 15/1e6, 'output': 75/1e6, 'cacheRead': 1.5/1e6}

data = json.load(sys.stdin)
g = data.get('global', {})

# 方案 A: 实际混合路由成本
actual_cost = g.get('totalCost', 0)

# 方案 B: 全部按 Opus 重定价
total_input = g.get('totalInputTokens', 0)
total_output = g.get('totalOutputTokens', 0)
all_opus_cost = total_input * OPUS_PRICING['input'] + total_output * OPUS_PRICING['output']

# 输出
print(f'=== 成本对比报告 ===')
print(f'总请求数: {g.get(\"totalRequests\", 0)}')
print(f'总 input tokens: {total_input:,}')
print(f'总 output tokens: {total_output:,}')
print()
print(f'方案 A (混合路由): \${actual_cost:.4f}')
print(f'方案 B (全 Opus):  \${all_opus_cost:.4f}')
if all_opus_cost > 0:
    saving = (1 - actual_cost / all_opus_cost) * 100
    print(f'节省: {saving:.1f}%')
print()
print(f'Tier 分布: {json.dumps(g.get(\"perTier\", {}))}')
print(f'Model 分布: {json.dumps(g.get(\"perModel\", {}))}')
print(f'Role 分布: {json.dumps(g.get(\"perRole\", {}))}')
"
```

### 单体 Opus 估算方法（方案 C）

子 agent 隔离时各自 fresh context。单体会话中所有 phase 的上下文累积，计算步骤：

1. 从 stats 的 `requestLog` 反推各 agent 最终上下文大小：
   `Cfinal ≈ 2 × TotalSent / N - C0`（N=turns, C0=系统提示约 5K）
2. 模拟 phases 串行执行，每 phase 累积前序 context
3. 每 turn 的 cache = 当前累积上下文，new input = 该 turn 新增内容
4. 汇总所有 turn 的 cache + input，按 Opus 单价计算

```bash
cat ~/.pilotdeck/router/stats.json | python3 -c "
import json, sys

OPUS = {'input': 15/1e6, 'output': 75/1e6, 'cache': 1.5/1e6}
C0 = 5000  # 系统提示 token 估算

data = json.load(sys.stdin)
sessions = data.get('sessions', {})

# 收集所有 session 的 token 数据
total_monolithic_cost = 0
cumulative_context = C0

for sid, s in sessions.items():
    logs = s.get('requestLog', [])
    for log in logs:
        usage = log.get('usage', {})
        inp = usage.get('inputTokens', 0)
        out = usage.get('outputTokens', 0)
        # 单体模式下，每次请求都带上累积上下文
        turn_cache = cumulative_context
        turn_new = inp
        turn_cost = (turn_cache * OPUS['cache'] + turn_new * OPUS['input'] + out * OPUS['output'])
        total_monolithic_cost += turn_cost
        cumulative_context += inp + out

print(f'方案 C (单体 Opus 估算): \${total_monolithic_cost:.4f}')
print(f'累积上下文: {cumulative_context:,} tokens')
"
```

---

## 常见问题与修复

### 问题 1: 主 agent 不委派，直接执行

**根因**：模型的指令遵从度不足（Sonnet 级别），或编排 prompt 未注入。

**修复**：
1. 确认 `mainAgentModel` 是 Opus 级别
2. 确认 `skillExtensionId` 对应的插件和 skill 存在
3. 在 `allowedTools` 中去掉执行类工具，只保留 `Agent`、`Task`、`Read` 等

### 问题 2: 子 agent 超时

**根因**：任务太复杂或 provider 响应慢。

**修复**：
- 增大 `subagentMaxTokens`（默认 48000）
- 增大 provider 的 `timeoutMs`

### 问题 3: Token 统计不完整

**根因**：`TokenStatsCollector` 内存中有未 flush 的数据。

**修复**：
- `TokenStatsCollector` 每 5 分钟自动 flush
- 也可以等进程正常退出时 flush
- 如果需要立即查看，重启 ui bridge 会触发 flush

### 问题 4: 成本计算不准确

**根因**：`modelPricing` 未配置或使用了默认定价。

**修复**：
- 在 `router.stats.modelPricing` 中为所有使用的模型配置准确价格
- 或依赖 provider 返回的 `nativeCost`（如果 provider 支持）

---

## 关键文件

| 文件 | 用途 |
|------|------|
| `~/.pilotdeck/pilotdeck.yaml` | 全局配置 |
| `~/.pilotdeck/router/stats.json` | Token 统计持久化数据（测试前用 `echo '{}'` 重置） |
| `src/router/stats/TokenStatsCollector.ts` | 统计收集与成本计算逻辑 |
| `src/router/orchestrate/applyOrchestration.ts` | 编排逻辑 |
| `src/router/tokenSaver/classifyAndRoute.ts` | 分级路由逻辑 |
| `src/router/config/schema.ts` | 配置类型（RouterStatsConfig.modelPricing 等） |

---
name: pilotdeck-router-debug
description: >-
  排查 PilotDeck RouterRuntime 路由不生效、统计不显示、分级异常等问题。
  涵盖 ui bridge → gateway → RouterRuntime → provider 链路诊断、
  tokenSaver 分级排查、stats 数据验证、常见故障修复。
  Use when the user reports routing not working, stats missing, tier classification wrong,
  token count zero, or asks about PilotDeck router debugging.
---

# PilotDeck Router 排查指南

## 架构概览

```
浏览器 → ui bridge (:3001)
            ├── Express REST API (/api/*)
            ├── WebSocket (/ws) → PilotDeck Gateway
            │                       ├── RouterRuntime
            │                       │     ├── tokenSaver (classifyAndRoute)
            │                       │     ├── autoOrchestrate (applyOrchestration)
            │                       │     └── TokenStatsCollector
            │                       └── ModelRuntime → Provider API
            └── Static assets (ui/dist/)
```

关键点：
- 路由逻辑在 `RouterRuntime` 中，是 PilotDeck 内置的，无外部进程
- 配置在 `~/.pilotdeck/pilotdeck.yaml` 的 `router:` 段
- 统计持久化到 `~/.pilotdeck/router/stats.json`

## 快速诊断清单

遇到 "路由不工作" 时，按以下顺序排查：

### 1. 确认 ui bridge 在运行

```bash
curl -s http://localhost:3001/api/health
```

- 返回 JSON → ui bridge 在运行
- 连接拒绝 → ui bridge 没起来

```bash
lsof -i :3001 | head -3    # 确认端口被监听
```

### 2. 确认 router 配置存在

```bash
python3 -c "
import yaml, os
with open(os.path.expanduser('~/.pilotdeck/pilotdeck.yaml')) as f:
    cfg = yaml.safe_load(f)
r = cfg.get('router', {})
print(f'router section exists: {bool(r)}')
ts = r.get('tokenSaver', {})
print(f'tokenSaver.enabled: {ts.get(\"enabled\", False)}')
print(f'tokenSaver.judge: {ts.get(\"judge\", \"NOT SET\")}')
print(f'tokenSaver.tiers: {list(ts.get(\"tiers\", {}).keys())}')
ao = r.get('autoOrchestrate', {})
print(f'autoOrchestrate.enabled: {ao.get(\"enabled\", False)}')
st = r.get('stats', {})
print(f'stats.enabled: {st.get(\"enabled\", False)}')
"
```

- **router 段不存在** → 路由完全禁用，所有请求走 `agent.model` 默认模型
- **tokenSaver.enabled: false** → 不做分级，所有请求走 `scenarios.default`
- **stats.enabled: false** → 不收集统计

### 3. 检查 stats 数据

```bash
cat ~/.pilotdeck/router/stats.json 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    g = data.get('global', {})
    print(f'Total requests: {g.get(\"totalRequests\", 0)}')
    print(f'Sessions: {len(data.get(\"sessions\", {}))}')
    print(f'Per tier: {json.dumps(g.get(\"perTier\", {}))}')
    print(f'Per model: {json.dumps(g.get(\"perModel\", {}))}')
except:
    print('No stats data (file empty or missing)')
" 2>/dev/null || echo "Stats file not found"
```

- **Requests > 0** → 路由在工作，问题可能在显示或配置
- **Requests = 0** → 路由没收到请求或 stats 未启用

### 4. 检查 provider 配置

```bash
python3 -c "
import yaml, os
with open(os.path.expanduser('~/.pilotdeck/pilotdeck.yaml')) as f:
    cfg = yaml.safe_load(f)
providers = cfg.get('model', {}).get('providers', {})
for name, p in providers.items():
    models = list(p.get('models', {}).keys())
    print(f'{name}: protocol={p.get(\"protocol\")}, url={p.get(\"url\",\"?\")[:50]}, models={models}')
"
```

确认 `router.tokenSaver.judge` 和各 tier 的 `model` 引用的 provider/model 组合在 `model.providers` 中存在。

### 5. 验证 provider/model 引用格式

PilotDeck 使用 `provider/model` 格式引用模型（如 `openrouter/anthropic/claude-sonnet-4`）。
`resolveProviderRef` 函数使用 **第一个** `/` 分割：

- `openrouter/anthropic/claude-sonnet-4` → provider=`openrouter`, model=`anthropic/claude-sonnet-4`
- `deepseek/deepseek-v4-pro` → provider=`deepseek`, model=`deepseek-v4-pro`

确认 `model.providers.<provider>.models.<model>` 路径完整匹配。

---

## 常见问题与修复

### 问题 1: 所有请求走同一个模型（tokenSaver 不生效）

**排查**：

1. 确认 `router.tokenSaver.enabled: true`
2. 确认 `router.tokenSaver.judge` 指向有效模型
3. 确认 judge 模型的 provider 有正确的 `url` 和 `apiKey`
4. 检查 `judgeTimeoutMs`（默认 5000ms），如果 judge 响应超时会 fallback 到 `defaultTier`

**验证 judge 模型可用**：

手动测试 judge provider 是否能正常响应（以 openrouter + gemini-flash 为例）：

```bash
curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash",
    "messages": [{"role":"user","content":"Classify: hi"}],
    "max_tokens": 50,
    "temperature": 0
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])"
```

### 问题 2: 统计文件为空或不更新

**排查**：

1. 确认 `router.stats.enabled: true`
2. `TokenStatsCollector` 每 5 分钟自动 flush 到磁盘
3. 如果刚发请求，stats 可能还在内存中。等 5 分钟或重启 ui bridge 触发 flush
4. 检查文件权限：`ls -la ~/.pilotdeck/router/stats.json`

**手动触发 flush**：重启 ui bridge 进程会在退出时 flush。

### 问题 3: 分级全部是 COMPLEX

**根因**：rules 中 `"tool_result → COMPLEX"` 把 agentic loop 中间步骤全部归为 COMPLEX。

**修复**：在 `router.tokenSaver.rules` 中添加：

```yaml
rules:
  - "CRITICAL: Messages with tool_result are agentic loop CONTINUATION — classify as MEDIUM, NOT COMPLEX."
  - "When unsure, default to MEDIUM."
```

并设 `defaultTier: MEDIUM`。

### 问题 4: autoOrchestrate 不触发

**排查**（按顺序）：

| # | 检查 | 方法 |
|---|------|------|
| 1 | tokenSaver 分类正确 | 检查 stats `perTier` 有 COMPLEX |
| 2 | autoOrchestrate.enabled | 读 pilotdeck.yaml |
| 3 | triggerTiers 包含 COMPLEX | 读 pilotdeck.yaml |
| 4 | mainAgentModel 有效 | 确认 provider/model 存在 |
| 5 | 是否为 mainAgent | 子 agent 不触发编排 |

### 问题 5: 成本计算显示 $0.0000

**根因**：

1. `modelPricing` 未配置且模型名不匹配内置默认定价规则
2. provider 未返回 `nativeCost`

**修复**：在 `router.stats.modelPricing` 中配置：

```yaml
stats:
  enabled: true
  modelPricing:
    anthropic/claude-sonnet-4:
      input: 3
      output: 15
      cacheRead: 0.3
```

内置默认定价覆盖的模型模式（`TokenStatsCollector.ts`）：
- `deepseek.*flash`, `deepseek.*chat`, `deepseek.*reasoner`
- `claude.*opus`, `claude.*sonnet`, `claude.*haiku`
- `gpt-4o-mini`, `gpt-4o`, `gpt-4.1`
- `gemini.*flash`, `gemini.*pro`

如果模型名不匹配这些模式，需要手动配置 `modelPricing`。

### 问题 6: 403 / 网络错误

**排查**：

1. 检查 provider `url` 是否可达
2. 检查 `apiKey` 是否有效
3. 如果在中国大陆，Node.js 不自动使用系统代理。设置环境变量：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 cd ui && npm run start
```

---

## 重启流程

```bash
# 1. 杀旧进程
kill $(lsof -ti :3001) 2>/dev/null || true
sleep 2

# 2. 重新构建（如果修改了源码）
cd /Users/a1/Desktop/claw/PilotDeck && npm run build

# 3. 启动 ui bridge
cd ui && npm run start

# 4. 验证
curl -s http://localhost:3001/api/health
```

## 关键文件

| 文件 | 用途 |
|------|------|
| `~/.pilotdeck/pilotdeck.yaml` | 主配置（router, model, agent） |
| `~/.pilotdeck/router/stats.json` | 路由统计持久化数据 |
| `src/router/RouterRuntime.ts` | 路由运行时主逻辑 |
| `src/router/config/schema.ts` | 配置类型定义 + `resolveProviderRef` |
| `src/router/tokenSaver/classifyAndRoute.ts` | 分级路由逻辑 |
| `src/router/stats/TokenStatsCollector.ts` | 统计收集 + 成本计算 + 默认定价 |
| `src/router/orchestrate/applyOrchestration.ts` | 编排逻辑 |
| `ui/server/index.js` | ui bridge 入口 |
| `ui/server/pilotdeck-bridge.js` | 内嵌 gateway 桥 |
| `ui/server/services/pilotdeckConfig.js` | 配置加载和热重载 |

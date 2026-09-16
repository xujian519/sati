# Sati × PilotDeck 引入方案（2026-09-11 后合并 PR 批次）

Status: proposed（P1 已落地，见 `docs/notes/implemented/2026-09-16-tokenizer-special-token-literals.md`）
范围：PilotDeck 在 2026-09-11 之后合并的 10 个 PR 中，经评估值得引入的 6 项
基准：Sati `main`，HEAD `6e151032a`；上游 tag 之外新增 PR #593（2026-09-16 合并，未进 tag 列表）
分支策略：每项一条分支 + 一个 PR（AGENTS.md 关键环境事实：main 受保护）

---

## 一、决策摘要（已与用户确认）

| 分叉 | 选定 |
|---|---|
| #588「未配置 = 关闭」范围 | **router + `tools.webSearch` + `tools.paperSearch`**；不动 `memory.enabled` 默认值，不动 `memoryService` 调度器 |
| #593/#570 长回答开头丢失 | **网关本地绝对投影**（自推通道 + 轮内序号），协议 MINOR 升 1.9；不碰 model 层、不碰 AgentLoop、不重录 llm-replay fixture |
| #587 推理强度配置化 | **只做「不静默夹取」**；保留 temperature、GEMINI/QWEN 预算表、`isReasoningOnlyModel` 白名单 |

## 二、批次一览（按落地顺序，每项独立可发布）

| 阶段 | 项目 | 来源 | 规模 | 风险 | 交付形态 |
|---|---|---|---|---|---|
| P1 | tokenizer 特殊 token 放行 | #574 commit `f2b2b3f0` | 3 行 + 1 spec | 极低 | 分支 `fix/tokenizer-special-token-literals` |
| P2 | 压缩终态可见（降级 / 失败 / 取消） | #570 切片 | ~10 文件 | 中 | 分支 `fix/compaction-terminal-state` |
| P3 | 可选功能「未配置 = 关闭」 | #588 裁剪版 | ~8 文件 | 中高 | 分支 `fix/optional-feature-defaults` |
| P4 | 活跃 turn 绝对投影 + 协议 1.9 | #593/#570 切片 | ~5 文件 | 中 | 分支 `feat/active-turn-absolute-projection` |
| P5 | 推理强度不静默夹取 | #587 切片 | 1 文件（10 处） | 中 | 分支 `fix/thinking-effort-no-silent-clamp` |
| P6 | 展示层小修（Bash 信封解包 / 用户消息 turnId 短路） | #590 + #570 切片 | ~5 文件 | 低 | 分支 `fix/chat-presentation-polish` |

依赖关系：**P3 不依赖 P6**，但 P3 的 UI 写侧修复（见 P3-0）必须先于 P3 的语义翻转落地，否则会引入"一次点击静默关闭论文检索"的回归。P4 与其余各项无耦合。P1、P5 完全独立。

---

## P1 — tokenizer 特殊 token 放行（#574 切片 A）

### 症状与证据

`countTokens` 遇到特殊 token 字面量会抛异常。本机复现：

```
t.encode('a <|endoftext|> b')        → 抛: The text contains a special token that is not allowed: <|endoftext|>
t.encode('a <|endoftext|> b', [], []) → 正常返回 9 个 token
```

根因是 `js-tiktoken/lite` 的 `encode(text, allowedSpecial = new Set(), disallowedSpecial = "all")` 默认值——`disallowedSpecial = "all"` 命中字面量即抛。

触发面：工具输出或文件内容里出现 `<|endoftext|>`、`<|im_start|>` 这类字面量时，预算计算抛错。调用方：`ToolResultBudget`、`TokenBudgetManager`、`src/tool/builtin/filesystem/read-file/text.ts`、`src/router/utils/countTokens.ts`。

### 改动清单

| 文件:行号 | 改法 |
|---|---|
| `src/context/budget/tokenizer.ts:82` | `getTokenizer().encode(sample)` → `encode(sample, [], [])` |
| `src/context/budget/tokenizer.ts:88` | 全量编码分支同上 |
| `src/context/budget/tokenizer.ts:91` | 短文本分支同上 |
| `src/context/budget/tokenizer.ts` 文件头或 `countTokensGuarded` 上方 | 加一行注释说明：默认 `disallowedSpecial = "all"` 会对字面量抛错，特殊 token 拼写按普通文本计数（上游 #574 移植） |
| `tests/context/budget/tokenizer-cache.spec.ts` 的 `tok.encode` monkey-patch | 适配新调用形状：`(text) => original(text)` → `(...args) => { encodeCalls += 1; return original(...args); }`（否则包装器吞掉后两个参数，测试会假绿） |

### 新增测试

新建 `tests/context/budget/tokenizer-special-tokens.spec.ts`（与既有 `tokenizer-cache.spec.ts` / `tokenizer-benchmark.spec.ts` 同目录，避免与缓存测试的 monkey-patch 互相干扰）：

1. `countTokens("a <|endoftext|> b")` 不抛，返回值 > 0
2. `countTokensGuarded` 返回 `mode: "full"`
3. **等价性锚**：对不含字面量的常规文本，`countTokens(text)` 与 `getTokenizer().encode(text, [], [])` 结果一致
4. 超过 512 字符且**样本区间内含字面量**的长文本不抛（覆盖抽样分支）
5. 同一含字面量文本二次调用命中缓存且结果一致

### 验收命令

```bash
pnpm build
node --test --test-force-exit dist/tests/context/budget/tokenizer-special-tokens.spec.js \
                              dist/tests/context/budget/tokenizer-cache.spec.js
pnpm check
```

### 决策记录

`docs/notes/implemented/2026-09-16-tokenizer-special-token-literals.md`（骨架：Problem / Decision / Alternatives considered / Consequences）。

`## Alternatives considered` 至少包含：
- **在调用方 catch 后回退字符数估算** — 落选：预算静默失真，比抛错更难发现
- **encode 前 strip 掉特殊 token 拼写** — 落选：改变了被计数文本，且与内容哈希缓存键的语义不一致
- **换 tokenizer 实现** — 落选：超出缺陷范围，且 o200k_base 与厂商用法一致

### 风险与回滚

对不含特殊 token 字面量的文本编码结果完全不变（默认 `disallowedSpecial` 只影响校验，不影响普通文本编码）。回滚：还原 3 处调用参数即可，无数据形态变化。

---

## P2 — 压缩终态可见（降级 / 失败 / 取消）

### 症状与证据

链路现状（已逐点核码）：

- `compact_started` / `compact_completed` 事件存在，定义在 `src/agent/protocol/events.ts:44-62`，唯一生产者 `src/context/compaction/CompactionEngine.ts:173-180`（started）、`:279-289`（completed）。`compact_completed.status` 当前只有 `"fallback" | "success"` 两个字面量（`:286`）。
- **全仓无 `compact_failed` / `compact_cancelled`**（grep 零命中）。
- 摘要降级**已经落盘**：`src/agent/loop/compactionExecutor.ts:131-134` 写入 `compactMetadata.extra = { tier, summarySucceeded }`；类型在 `src/session/transcript/TranscriptEntry.ts:95`（`extra?: Record<string, unknown>`）。
- 但 Web 历史投影的**白名单把它丢弃**：`src/web/server/injectWebMessages.ts:89-107` 只透传 `compactionId/trigger/preTokens/postTokens/messagesSummarized/shadowedRanges`。于是历史投影无法表达"这次只是降级摘要"。
- 硬失败只写日志、不落盘、不发事件：`src/agent/loop/compactionExecutor.ts:98-108`（`logAutoCompactFailure` → `autoCompactLogger.warn`）。
- 取消被吞成降级成功：`CompactionEngine.ts:205-210` 把 abort 异常转成 `summaryError` → `status: "fallback"`，照常落 boundary。
- UI 侧三态类型早已预留但无生产者：`ui/src/components/chat/types/types.ts:170-179` 的 `CompactProgress.state: "started" | "running" | "failed" | "completed"` 中 `"failed"` 全仓无生产者。
- `CompactBoundaryRow` 无论成功还是降级都渲染同一个绿色"已压缩"徽标（`ui/src/components/chat/view/subcomponents/CompactBoundaryRow.tsx:9-82`）。

### P2a — 零新字段：让「降级」可见

| 文件:行号 | 改法 |
|---|---|
| `src/web/server/injectWebMessages.ts:89-107` | `compactBoundaryMetadata` 增读 `cm.extra`：`summarySucceeded`（boolean）、`tier`（string）写入 `meta`；用 `isRecord` 守卫，缺省不写键 |
| `ui/src/components/chat/types/types.ts:124-141` | 增 `compactSummarySucceeded?: boolean` 与 `compactTier?: string` |
| `ui/src/components/chat/hooks/useChatMessages.ts:360-376` | 映射上述两个字段 |
| `ui/src/components/chat/view/subcomponents/CompactBoundaryRow.tsx:9-82` | 徽标按状态取色：成功=现有绿色，降级=琥珀色 + 新文案 |
| `ui/src/i18n/locales/{en,zh-CN}/chat.json` | `compact.degraded` 新键（AGENTS.md 规则 4 强制双 locale） |

### P2b — 新增失败 / 取消信号

设计要点：**在 `CompactionEngine` 内部产出终态，不在 `compactionExecutor` 的 catch 里补** —— 因为 `compactionId` 是引擎内部生成的，executor 侧拿不到，补出来的事件无法与 `compact_started` 配对。

| 文件:行号 | 改法 |
|---|---|
| `src/context/compaction/CompactionEngine.ts:193-210` | 增 `let summaryCancelled = false;`；catch 内 `summaryCancelled = input.signal?.aborted === true;`（`input.signal` 已在 `:200` 传给 `summarize`） |
| `src/context/compaction/CompactionEngine.ts:286` | `status: summaryCancelled ? "cancelled" : summaryError ? "fallback" : "success"` |
| `src/context/compaction/CompactionEngine.ts` `run` 方法体 | 在 `compact_started`（`:173`）之后包裹 try/catch：硬抛时先 `eventEmitter({ type: "compact_completed", …, compactionId, status: "failed" })` 再 rethrow。这样"失败"有配对 id，且不需要 executor 侧补事件 |
| `src/agent/protocol/events.ts:53-62` | `compact_completed.status: string` 收窄为 `"success" \| "fallback" \| "cancelled" \| "failed"`（编译期把关；同字段类型收窄不新增产/消边，若 `check:event-matrix` 报红再跑 `pnpm gen:event-matrix`） |
| `src/web/client/eventMapping.ts:398-413` | **关键分流**：`status` 为 `"failed" \| "cancelled"` 时不产出 `kind: "compact_boundary"`，改产出 `kind: "status"` 且 `compactProgress.state: "failed"`，并把 `status` 透传进帧。否则失败仍渲染成"已压缩" |
| `src/gateway/client/eventMapping.ts:293-305` | 确认 `agent_status.detail.status` 已随 `compact_completed` 透传（现状含 `status`），无需改动；若为 `failed` 分支则同步加注释说明为何不走 `agent_status("error")` |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts:932-941` | `case "compact_boundary"` 当前无条件清状态并保持 loading；改为按 `status` 分支：失败/取消时显式清 `compactProgress` 残留 |
| `ui/src/components/chat-v2/MessagesPaneV2.tsx:1416-1425` | `compactProgress.state === "failed"` 时标题改用 `working.compactFailed`，并给失败 severity。`ProcessTrace` 本身无需改（`phase/state` 是自由字符串） |
| `ui/src/i18n/locales/{en,zh-CN}/chat.json` | 新增 `working.compactFailed`、`working.compactCancelled` |

### ⚠️ 必须规避的陷阱

**禁止**把失败/取消走 `agent_status` 的 error 形态。`src/agent/turn/TurnRunner.ts:327-332` 会把任意可见失败状态置 `hasRecordedVisibleFailureStatus = true`，进而在 `:372` **吞掉真正的 turn 失败横幅**；桥侧 `ui/server/sati-bridge.js:818-820`、`:875` 也会把后续 error 帧静默掉。这是本阶段最重要的风险点，必须在代码注释与决策记录里写明。

### 本阶段明确不做（记录为已知缺口，不算完成）

- **tier-1（micro）/ tier-2（snip）压缩无任何事件**：`src/context/DefaultContextRuntime.ts:481-546` 返回 `{type:"compacted", tier}` 但不带 `result`，而 `persistCompactSnapshot` 开头 `if (!... || !compact.result) return;`（`compactionExecutor.ts:115`）→ 这两级既无事件也无 transcript 痕迹。因此"压缩运行中"只覆盖 tier-3。
- `compactProgress.level/stage/label` 永远走兜底值（生产者不带这些字段，映射却读它们）；`working.compactingLevel`（`en/chat.json:69`、`zh-CN/chat.json:69`）**是无引用的死键** —— 本阶段顺手删除（双 locale）。
- 实时边界帧不带 `shadowedMessages`（`src/web/client/eventMapping.ts:398-413` 未含），故实时那条边界行展开不出历史，刷新后由历史投影替换才有。

### 新增 / 修改测试

| 测试 | 位置 | 覆盖 |
|---|---|---|
| 引擎终态 | `tests/context/compaction-engine.spec.ts`（既有，`:213-226`、`:432-437` 断言事件序列恰为 `["compact_started","compact_completed"]`，成功路径不受影响） | 新增失败路径：硬抛时事件序列为 started → completed(status=failed) 且 id 配对；abort 时 status=cancelled |
| 落盘 | `tests/agent/loop/context-cap.spec.ts:432-448`（既有，已断言 boundary 含 `extra.summarySucceeded`） | 保持通过即可 |
| 历史投影 | `tests/web/eventMapping.spec.ts` 或 `tests/web/compact-replay.spec.ts`（均存在） | 新增：`summarySucceeded:false` 的历史边界 metadata 带出该字段 |
| 帧分流 | `tests/web/eventMapping.spec.ts` | 新增：`compact_completed{status:"failed"}` **不**产出 `kind:"compact_boundary"` |
| UI | 新增 vitest（`ui/src/components/chat-v2/MessagesPaneV2.render.test.tsx:932-960` 已有相关用例可扩展） | 失败态的标题与 severity；降级徽标配色 |

### 验收命令

```bash
pnpm build
node --test --test-force-exit dist/tests/context/compaction-engine.spec.js \
                              dist/tests/agent/loop/context-cap.spec.js \
                              dist/tests/web/eventMapping.spec.js
pnpm check
pnpm --filter sati-ui test
```

**浏览器验证（必做）**：`pnpm dev` 后打开 `http://localhost:5173`，在一个长会话里触发自动压缩，确认压缩边界行显示；随后用 `abort`（停止按钮）中断一次压缩，确认不再出现绿色"已压缩"徽标而是失败/取消态，且**真正的 turn 失败横幅仍然出现**（这是陷阱项的直接验证）。

### 决策记录

`docs/notes/implemented/2026-09-16-compaction-terminal-state.md`

`## Alternatives considered`：
- **新增独立 `compact_failed` / `compact_cancelled` 事件类型** — 落选：新增事件变体要重跑事件矩阵，且 `compact_completed` 语义可自然扩展为"压缩以某终态结束"
- **复用 `agent_status` 的 error 形态** — 落选：会被 `TurnRunner` 记为可见失败并吞掉 turn 失败横幅（见陷阱节）
- **只在 UI 侧把"无 postTokens"当失败** — 落选：幻觉式判据，会把正常降级误判为失败

---

## P3 — 可选功能「未配置 = 关闭」（#588 裁剪版）

### 症状与证据

| 位置 | 现状（问题） |
|---|---|
| `src/cli/routerDefaults.ts:37-47` | `router` 段缺失时返回**全 `enabled: true`** 的默认配置（scenarios / fallback / zeroUsageRetry / tokenSaver / autoOrchestrate / stats 全开）。未配置路由的用户在不知情下跑着智能路由与分类调用。该函数**全仓无单测**（`tests/` grep 零命中） |
| `src/cli/projectRuntimeFactory.ts:336-346` | `webSearchConfig?.enabled === false ? {webSearch:false} : webSearchConfig ? {...} : {}` —— 缺配置落到 `{}`，该处注释自承"未提供时工具可能从 provider 特定环境变量推断 GLM/Tavily"。`paperSearch` 同形（`:352-364`） |
| `src/pilot/config/parseToolsConfig.ts:195`、`:403` | `return Object.keys(result).length > 0 ? result : undefined` —— 存在的空块（`webSearch: {}`）被丢弃，失去"遗留 opt-in"语义 |
| `ui/src/components/settings/view/agentSearch/components/ToolsSection.tsx:60 / :74 / :96` | **整段替换** `patch(config, ["tools"], {webSearch})`，把兄弟段 `tools.paperSearch` 丢掉；`:74` 在字段清空时写 `tools: undefined`，整个 `tools:` 段从 YAML 消失 |
| `ui/server/services/satiConfig.js:64-103` | `buildDefaultSatiConfig` 不含 `router` / `tools` 键；`normalizeSatiConfig:108-131` 无遗留守卫 |

### 变更语义（对齐上游 #588）

`isOptionalFeatureEnabled(cfg) = cfg != null && cfg.enabled !== false`

- 段缺失 → 关
- 段存在但无 `enabled` → **开**（遗留配置的原有 opt-in 含义）
- 显式 `true` / `false` → 永远优先

### P3-0 前置条件：修 UI 写侧整段替换（必须先于语义翻转）

| 文件:行号 | 改法 |
|---|---|
| `ToolsSection.tsx:60`（`setProvider`） | `patch(config, ["tools"], nextTools)` → `patch(config, ["tools", "webSearch"], webSearchConfigForProvider(...))`，保留 `tools.paperSearch` |
| `ToolsSection.tsx:74`（`setField`） | 同上，写 `["tools", "webSearch"]`；清空时写 `undefined` 只清这一子键 |
| `ToolsSection.tsx:96`（`setCustomField`） | 同上 |

先确认 `ui/src/components/settings/view/modelPool/utils/patch.ts:19-29` 对 `undefined` 值的写入语义（期望：该键被移除，YAML 序列化时省略——`yaml` 的 `keepUndefined` 默认 `false`）。补一条 vitest 断言"切换 provider 后 `tools.paperSearch` 仍在"。

### P3-1 后端

| 文件 | 改法 |
|---|---|
| **新建** `src/pilot/config/optionalFeature.ts` | 导出 `isOptionalFeatureEnabled(config: { enabled?: boolean } \| null \| undefined): boolean`，JSDoc 写明三态语义与「上游 #588 移植」 |
| `src/cli/routerDefaults.ts:20-47` | 合并三个分支为：`if (!router \|\| !isOptionalFeatureEnabled(router)) return { enabled: false };` 然后保留原有填充默认值的返回体（对齐上游 `createLocalGateway.ts` 的 `ensureRouterConfig` 改法） |
| `src/cli/projectRuntimeFactory.ts:336-346` | `...(!isOptionalFeatureEnabled(webSearchConfig) ? { webSearch: false as const } : webSearchConfig ? {...} : {})`；同步改写那段落款注释（不再说"工具可能从环境变量推断"） |
| `src/cli/projectRuntimeFactory.ts:352-364` | paperSearch 同形 |
| `src/pilot/config/parseToolsConfig.ts:195` | `return result;` + 上游注释（presence is meaningful even if every legacy field was discarded） |
| `src/pilot/config/parseToolsConfig.ts:403` | 同上（paperSearch） |
| `src/pilot/config/parseToolsConfig.ts:62` | **不改** —— `tools` 段级别"空对象 ≡ 无段"保留（上游测试即断言 `parseToolsConfig({}) === undefined`） |
| `src/pilot/config/types.ts` | `PilotWebSearchConfig.enabled` 的 JSDoc 由"Defaults to true when omitted"改为"Missing section is off; legacy sections without this flag remain enabled" |

### P3-2 UI-server 与 UI 读取侧（必须与后端同步，否则面板显示「开」而实际「关」）

| 文件:行号 | 改法 |
|---|---|
| `ui/server/services/satiConfig.js:64-103` | `buildDefaultSatiConfig` 增 `router: { enabled: false }`、`tools: { webSearch: { enabled: false } }`；**`memory.enabled` 保持 `true` 不动**（用户已确认排除 memory） |
| `ui/server/services/satiConfig.js:108-131` | `normalizeSatiConfig` 增**遗留守卫**（上游原样形态）：`for (const key of ['router']) if (isRecord(source[key]) && source[key].enabled === undefined) normalized[key].enabled = true;` 以及 `if (isRecord(source.tools?.webSearch) && source.tools.webSearch.enabled === undefined) normalized.tools.webSearch.enabled = true;`。注释写明"旧段蕴含开启，不允许新默认值在读写往返中静默关闭已有功能" |
| `ui/src/components/settings/view/agentRoute/components/RouterSection.tsx:28` | `const enabled = r.enabled !== false` → `const enabled = config.router != null && r.enabled !== false` |
| `ui/src/components/settings/view/agentSearch/components/ToolsSection.tsx:33` | 同形，判 `config.tools?.webSearch != null` |
| `ui/src/components/settings/view/agentSearch/utils/webSearchConfig.ts:11` | **不改** —— 它已刻意保留 `enabled === undefined` 的三态（切 provider 不补默认值），正是新语义需要的 |
| `ui/src/components/settings/view/agentMemory/index.tsx:113` | **不改**（memory 不在本批范围） |

### 新增测试

| 测试 | 位置 | 覆盖 |
|---|---|---|
| router 三态 | **新建** `tests/cli/routerDefaults.spec.ts` | 缺段 → `{enabled:false}`；`{}` → enabled 且填齐默认子段；`{enabled:false}` → 短路；`{enabled:true, scenarios:…}` → 保留用户值 |
| tools 三态 | `tests/pilot/config/parseToolsConfig.spec.ts`（既有，仅 3 例） | 补：`tools` 缺失与 `{}` → `undefined`；`{webSearch:{}}` → `{webSearch:{}}` 且**无诊断**；`{webSearch:{region:"cn"}}` → 保留 + deprecated warning；`{paperSearch:{}}` 同形 |
| 遗留迁移（**核心**） | `ui/server/services/satiConfig.test.js`（既有，`:35-82` 已钉住"保存会物化 memory.enabled"） | 新增：含 `router: {scenarios:…}` 无 `enabled` 的遗留配置，读写往返后仍判开启；无 `router` 段的配置往返后仍判关闭；`tools.paperSearch` 在切换 webSearch provider 后仍存在（P3-0 的回归锚） |
| 设置面板四态 | **新建** `ui/src/components/settings/view/optionalFeatures.test.tsx`（对齐上游同名测试） | 参数化四态：未配置 / 显式关 / 显式开 / 遗留已配置；断言开关 `aria-checked` 分别为 false/false/true/true |
| 运行时门控 | **新建** `tests/gateway/optional-feature-defaults.spec.ts`（对齐上游同名测试） | 缺失段时 `web_search` / `paper_search` 不注册；遗留空块时注册 |

### 验收命令

```bash
pnpm build
node --test --test-force-exit dist/tests/cli/routerDefaults.spec.js \
                              dist/tests/pilot/config/parseToolsConfig.spec.js \
                              dist/tests/gateway/optional-feature-defaults.spec.js
pnpm check
pnpm --filter sati-ui test
```

**浏览器验证（必做）**：`pnpm dev` → 设置面板 → 路由/搜索两个面板。确认：(1) 首次打开（无对应配置段）开关显示为**关**；(2) 打开搜索开关并保存后，`sati.yaml` 出现 `tools.webSearch.enabled: true` 且 `paper_search`/`web_search` 工具恢复；(3) 在已有 `tools.paperSearch` 的配置上切换 Web Search provider 并保存，`paperSearch` **仍在**；(4) 关掉再打开开关，行为稳定。

### 风险与回滚

- **行为变更（必须写进发布说明）**：既有无 `router` 段的用户，场景分类 / TokenSaver / 自动编排 / 统计会关闭 —— **模型调用不受影响**，已核实禁用路径就是测试默认路径（`src/router/execution/executeRouterDecision.ts:249` 的直通分支，且 `:54` 注释说明全量套件里 router 一律 `enabled:false`）。无 `tools` 段的用户会失去 `web_search` / `paper_search` 注册，需在设置面板显式开启。
- **迁移守卫是安全关键**：`normalizeSatiConfig` 的守卫若不落地，一次"读取→保存"往返就会静默关闭遗留用户的既有功能。此条必须有测试钉住。
- 回滚：还原 `ensureRouterConfig` 的缺段分支与 `projectRuntimeFactory` 的两个三元即可；已写入 YAML 的 `enabled: false` 需用户手动开启（发布说明中说明）。

### 决策记录

`docs/notes/implemented/2026-09-16-optional-feature-defaults.md`

`## Alternatives considered`：
- **全量对齐上游（含 `memory.enabled` 默认值翻转）** — 落选：会让既有无 memory 配置段的用户停止记忆索引调度器（`ui/server/services/memoryService.js:415/444` 以 `config.memory?.enabled` 为闸），影响面超出本批收益
- **只做 router** — 落选：保留了"搜索被环境变量隐式开启"这一未被用户知情的状态
- **仅加诊断告警、暂不翻转语义** — 落选：告警无人看，等效于不修；翻转 + 迁移守卫已能覆盖风险

---

## P4 — 活跃 turn 绝对投影（#593/#570 切片）+ 协议 1.9

### 症状与证据

| 缺陷 | 证据 |
|---|---|
| 长回答开头 token 丢失 | `src/gateway/client/InProcessGateway.ts:259-260` 定义 `ACTIVE_TURN_EVENT_LIMIT = 500` / `ACTIVE_TURN_BYTE_LIMIT = 256 * 1024`；`:1198-1212` 超限即 `events.shift()` 逐条从头丢 delta（丢的正是同一段正文的**开头**）并置 `truncated` |
| 截断对 UI 不可见 | `truncated` 标记**在 `ui/src` 与 `ui/server` 无任何消费点**；桥侧 `getSessionActivityViaGateway`（`ui/server/sati-bridge.js:1110-1140`）返回对象只取 `active/activeRunId/events`，静默丢弃 `truncated`。`src/gateway/protocol/types.ts:381` 的 `truncated?: boolean` 因此是死数据 |
| delta 帧无稳定身份 | `assistant_text_delta` / `assistant_thinking_delta` 只带 `text`，唯一身份是 `runId`（`src/gateway/protocol/types.ts:220/223`）；映射在 `src/gateway/client/eventMapping.ts:462-475`（注意：**不在** `InProcessGateway.ts`，A11 拆解时已下沉） |
| 该区域零测试覆盖 | `getActiveTurnSnapshot` / `recordActiveTurnEvent` / `activeTurnReplays` 在 `tests/` 下零引用；`tests/gateway/active-turn-snapshot.spec.ts` 不存在 |

### 设计选择：网关本地 epoch，而非打通 provider blockId

`(runId, 通道 kind, 轮内序号 epoch)` 是**最小充分键**。理由：`ActiveTurnReplay` 已是 turn 内事件的唯一权威序列（建档 `:441-447`、销毁 `:652`），天然知道 turn 边界与到达顺序；缺的只是"同一 turn 内本通道出现了几段"。这个信息可在网关侧从 delta 流自推（kind 切换或 `model_request_started` 时 epoch++），**无需改动** `canonical.ts` / 四个 `providers/*/stream.ts` / `assembleModelMessage.ts` / `AgentLoop` / transcript 格式，也**不会**改变请求内容哈希（因此不触发 llm-replay fixture 重录）。

上游原样 blockId 路线的代价（本批不采用）：`canonical.ts:269-287` 给 delta 加 blockId → `anthropic/openai/openai-responses/google` 四个 `stream.ts` 各自生成 → `assembleModelMessage.ts:64-108` 按 blockId 归并缓冲区 → `AgentLoop.ts:503` 事件面 → `eventMapping.ts:462-475` 帧 → `types.ts:220/223` → 事件矩阵重生成 → fixture 重录。

### 改动清单

| 文件:行号 | 改法 | 预估 |
|---|---|---|
| `src/gateway/client/InProcessGateway.ts:259-267` | `ActiveTurnReplay` 增 `projection: Array<{ kind: "text" \| "thinking"; epoch: number; text: string }>` + `currentKind?: "text" \| "thinking"` + `textEpoch` / `thinkingEpoch` | ~20 行 |
| `src/gateway/client/InProcessGateway.ts:441-447` | 建档初值补新字段 | ~5 行 |
| `src/gateway/client/InProcessGateway.ts:1198-1212` | `recordActiveTurnEvent` 在 push 事件**之前**更新投影：`assistant_text_delta` → 若 `currentKind !== "text"` 则 `textEpoch++` 并 `currentKind = "text"`，追加到对应 epoch 块；thinking 同形。`model_request_started` → 两个 epoch 各自++、清 `currentKind`（覆盖 turn 内多步模型调用）。**截断只作用于 `events`，投影永不被 shift** | ~50 行 |
| `src/gateway/client/InProcessGateway.ts:792-811` | `getActiveTurnSnapshot` 增返回 `projection`；`truncated` 语义收紧为"事件日志被截断" | ~8 行 |
| `src/gateway/protocol/types.ts:373-385` | `GatewayActiveTurnSnapshot` 增可选 `projection?: { runId: string; blocks: Array<{ kind: "text" \| "thinking"; epoch: number; text: string }> }` | ~10 行 |
| `src/gateway/protocol/version.ts:47-90` | 台账追加 `1.9` 条目，**只填 `changes`**（无新方法）：active_turn_snapshot 响应新增可选 projection 绝对投影。形态对齐 1.2 / 1.5 / **1.6**（1.6 就是"给 active_turn_snapshot 加可选字段"的直系先例） | ~8 行 |
| `ui/server/sati-bridge.js:1110-1140`（`getSessionActivityViaGateway`） | 把 `snapshot.projection` 的 **text 块**映射为 `{ ...base, kind: "text", role: "assistant", id: \`active-turn:${sessionId}:${runId}:text:${epoch}\`, content: fullText, isFinal: true }`；并从 `snapshot.events` 转出的帧里**滤掉已被投影覆盖的 `stream_delta`**，避免同一文本既追加又覆盖 | ~40 行 |

### 为什么用 `kind: "text"` + 稳定 id 而不是 `kind: "stream_delta"`

- `stream_delta` / `thinking` 在 UI 是**无条件前缀追加**（`ui/src/components/chat/hooks/useChatRealtimeHandlers.ts:621-624`、`:633-639`）→ 发全量文本会重复累加。
- `kind: "text"` + `role: "assistant"` + 稳定 id 走 `appendRealtime` → `getUpsertKey` 按 id **覆盖**（`ui/src/stores/useSessionStore.ts:346-358`）→ 每轮轮询幂等，文本增长时同一行更新。

### 本阶段明确不做

- **thinking 通道不投影**。原因：`kind: "thinking"` 无条件追加，而 replay 应用路径只按**全文等价**判重（`useChatRealtimeHandlers.ts:143-158`）→ 追踪一次增长序列即可证明不幂等（`"abc"` → `"abcdef"` 会被二次追加成 `"abcabcdef"`）。修它需要改 UI store，超出本批范围。此缺口写入决策记录。
- `InProcessGateway.ts:383-387` 的 plan 模式用量提示直接 yield 一个**无 `runId`** 且**绕过 `recordActiveTurnEvent`** 的 `assistant_text_delta` —— 它本就不被重放，也不会被投影。记录为已知缺口。
- 提高 `ACTIVE_TURN_EVENT_LIMIT` / `BYTE_LIMIT`（只是把天花板抬高，不解决形态问题）。

### 新增测试

**新建 `tests/gateway/client/active-turn-projection.spec.ts`**（该区域首个测试，本身就是净增覆盖）：

1. 短 turn：投影拼接结果 == 事件重放拼接结果
2. 超限：推入 > 500 个 delta（或 > 256KB）后 `truncated === true`，而投影文本**完整**
3. `text → thinking → text` 产出 epoch 1 / 1 / 2，且两种通道各自独立编号
4. 新的 `model_request_started` 使两类 epoch 各自递增（覆盖 turn 内多步模型调用）
5. `turn_started` 建档后投影为空；turn 结束（`activeTurnReplays.delete`）后 `getActiveTurnSnapshot` 返回 `active:false` 且无 projection

**UI-server 侧**（`ui/server/`，`pnpm --filter sati-ui test` 覆盖）：断言同一投影重复喂两次，产出的 `kind:"text"` 帧 id 稳定（幂等性锚），且被投影覆盖的 `stream_delta` 帧已被滤除。

### 验收命令

```bash
pnpm build
node --test --test-force-exit dist/tests/gateway/client/active-turn-projection.spec.js
pnpm check:protocol-version   # 1.9 登记与 frames.ts 的两向集合断言
pnpm check
pnpm --filter sati-ui test
```

**浏览器验证（必做）**：`pnpm dev`，在一次**长回答**（要求模型输出足够长，触发 > 500 个 delta 或 > 256KB）流式过程中刷新页面。确认刷新后重放出的正文**含开头**，不是从中段开始；并确认正文没有重复段落（幂等性）。同时验证会话切换、断线重连两条路径行为一致。

### 决策记录

`docs/notes/implemented/2026-09-16-active-turn-absolute-projection.md`

`## Alternatives considered`：
- **上游原样 blockId 打穿** — 落选（本批）：改动面大一个数量级，且会改变请求内容哈希导致全部 llm-replay fixture 重录；epoch 序号对"绝对投影"这一目标已充分
- **提高事件/字节上限** — 落选：仍是同一个天花板，只是更高
- **让 UI 检测截断后自行提示** — 落选：UI 无法恢复没被送出的字节
- **投影与事件日志都保留完整副本** — 落选：内存翻倍；投影只需保留原文本，事件日志仍按原上限截断

### 风险与回滚

- **内存**：投影持有本 turn 的完整文本。上界为 maxOutputTokens × 步数，且 transcript 本就已把同样的内容落盘，属于已存在的量级。若需收紧，可对保留的 epoch 总数设上限并标记降级（不建议按字符截断——那会重新引入丢失）。此取舍写入决策记录。
- **协议**：MINOR 提升，`SATI_GATEWAY_PROTOCOL_VERSION_WEB = "1.0"`（`src/web/client/protocol.ts:12`）按 MAJOR 协商，不受影响；旧客户端不读 `projection` 即退回旧行为。
- 回滚：移除 `projection` 字段与桥侧映射即可，事件日志路径未被改动。

---

## P5 — 推理强度不静默夹取（#587 切片）

### 症状与证据

`src/model/thinking/registry.ts`（472 行）以模型名正则推断推理参数，`clampEffort`（`:438-455`）在请求的 effort 不在允许集合时**静默就近取整**（按 `rank` 距离）。10 处调用点：`:197, :205, :213, :221, :226, :245, :291, :356, :393`。用户选了 `max` 而厂商只支持到 `high` 时，看到的是一次"像成功了"的请求，实际被降级。

上游 #587 用显式 `model.thinking = { state, efforts, format }` 取代名字推断，并让 `parseThinkingSettings` 对非法值直接抛错。本批只取其中的**判据改进**，不引入新配置字段。

### 改动清单

| 文件:行号 | 改法 |
|---|---|
| `src/model/thinking/registry.ts:438-455` | 保留 `clampEffort` 供"别名"使用（`max → xhigh` 是**同义别名**，不是夹取），新增 `resolveEffort(mode, allowed): { effort?: …; unsupportedReason?: string }`：请求值在 `allowed` 内 → 返回该值；不在 → 返回 `unsupportedReason`，**不再就近取整** |
| `registry.ts:197, 205, 213, 221, 226, 245, 291, 393` | `effort: clampEffort(mode, [...])` → 改用 `resolveEffort`，未命中时返回 `{ ...plan, unsupportedReason: \`Model ${modelId} does not support thinking strength '${mode}'. Supported: ${allowed.join(", ")}.\` }` |
| `registry.ts:356`（`effort = clampEffort(mode, allowedEffort)`） | 同上，注意该分支在赋值后继续构造 plan，需改为提前 return |
| `registry.ts:441-444`（`max → xhigh` 归一） | **保留**，并补注释说明这是同义别名而非夹取（避免被后来者误删） |
| `src/pilot/config/types.ts` 或目录投影处 | 若模型目录已暴露 effort 能力，把 `allowed` 列表改为从目录读取（本批可仅加注释标注后续方向） |

`unsupportedReason` 的既有出口：`registry.ts:158-159` 抛 `ModelRequestError("unsupported_thinking", …)`。落地前确认该错误码在 `src/agent/loop/modelErrors.ts` 中被归类为**不可重试**且对用户可见可操作——若不可重试分类缺失，需在本阶段补上（否则会无意义重试）。

### 新增 / 修改测试

`tests/model/thinking/registry.spec.ts`（**已存在**）：

1. 参数化：对每类 provider 分支，请求一个不在允许集合内的 effort → 产出 `unsupportedReason` **且不含 `effort`**
2. 请求在允许集合内的 effort → 精确透传，无 `unsupportedReason`
3. `max` 在 `max` 允许时 → `max`；`max` 不被允许但 `xhigh` 被允许 → `xhigh`（别名行为回归锚，防止本阶段误删）
4. 逐条覆盖原 10 个 `clampEffort` 调用点至少各一例

### 验收命令

```bash
pnpm build
node --test --test-force-exit dist/tests/model/thinking/registry.spec.js
pnpm check
```

### 决策记录

`docs/notes/implemented/2026-09-16-thinking-effort-no-silent-clamp.md`

`## Alternatives considered`：
- **引入完整 `model.thinking` 配置字段（上游原样）** — 落选（本批）：需连带改 `src/model/config/schema.ts`、`parseModelConfig.ts`、`modelCatalog.ts` 与设置面板，收益与风险不匹配
- **删除 temperature 参数（上游同 PR 所为）** — **明确否决**：`src/patent/clarity/` 的确定性语义打分依赖 temp 0.1，删除会破坏专利清晰度准入门
- **同时删掉 GEMINI/QWEN 预算表与 `isReasoningOnlyModel` 白名单** — 落选：这些是真实厂商知识（如 kimi-k3 固定 1.0、deepseek-v4 静默忽略 temperature），压缩时应迁移而非丢弃
- **保留静默夹取但加日志** — 落选：用户仍然看到"成功"的降级请求，等于不修

### 风险与回滚

行为变更：原先"能跑但被降级"的组合现在会直接报错。属于**期望中的收紧**，但需在发布说明中列出受影响的组合（各 provider 的允许集合见 `registry.ts` 各分支）。回滚：还原 10 处调用点。

---

## P6 — 展示层小修

### P6a — Bash 结果信封解包（#590 切片）

**症状**：Sati 的 UI **原样显示** `BASH_RESULT[success][...]` 信封。已核实 `ui/src` 内无任何剥离逻辑（`grep "Assertions\|Interpretation\|stdout_visible\|retrieved_data_available" ui/src` 零命中），而 `src/tool/builtin/bash.ts:235-256` 会把信封 + `Assertions:` 六条 + `Interpretation:` + `stdout:` 前缀一起产出——用户看到的是包装而不是命令输出。

**改动**：

| 文件 | 改法 |
|---|---|
| **新建** `ui/src/components/chat/tools/toolPresentation.ts` | 移植上游 `displayText` / `objectValue` / `resultText` / `shellOutput`。**两处必须适配 Sati 的信封**：(a) 退出码接受任意整数（上游正则硬编码 `exit_code: (0)`），Sati 会产出 `null` 或非 0；(b) Sati 在 stdout 之后还会追加 `stderr:` 段，需一并切分（上游只切 stdout） |
| `ui/src/components/chat/tools/configs/toolConfigs.ts:145-175`（Bash 的 `result`） | `getContentProps` 与标题改用 `shellOutput()`：正文只给 stdout，标题带退出码与耗时；信封解析失败时**原样回退**显示原始文本（绝不吞内容） |

**测试**：新建 `ui/src/components/chat/tools/toolPresentation.spec.ts`（对齐上游同名 spec）。固件用 Sati 真实信封形状：`stdout_data` / `empty_stdout` / `stderr_only` / 非 0 退出码 / 纯文本（非信封，须原样返回）。

### P6b — 用户消息 turnId 短路（#570 切片）

**症状**：`ui/src/components/chat/hooks/useChatSessionState.ts:197` 的 `hasEquivalentUserMessage` 只比较"归一化文本 + 图片数 + 附件名"。同一文本连续发送两次（首次发送时，同一文本恰好与已存在的用户消息内容、图片数、附件名完全一致）会被判为重复，乐观气泡被吞掉。

**改动**：`ChatMessage.turnId?: string`（`ui/src/components/chat/types/types.ts:261`）与 `runId`（`:126`）已存在，可用。加：

```ts
const pendingTurnId = pendingUserMessage.turnId || pendingUserMessage.runId;
// …在 messages.some 内：
const messageTurnId = message.turnId || message.runId;
if (pendingTurnId || messageTurnId) return Boolean(pendingTurnId && messageTurnId && pendingTurnId === messageTurnId);
```

**测试**：扩展 `ui/src/components/chat/hooks/useChatSessionState.spec.ts`（**已存在**）——补"同文本同附件两次发送，第二次不被吞"与"turnId 缺失时退回原文本比较"两例。

### P6c — 清死键

`working.compactingLevel`（`ui/src/i18n/locales/en/chat.json:69`、`zh-CN/chat.json:69`）无任何代码引用，删除（双 locale）。

### 验收命令

```bash
pnpm check
pnpm --filter sati-ui test
```

**浏览器验证（必做）**：`pnpm dev` →
1. 让 agent 执行一条 `ls` / `pwd`，确认工具卡片正文是命令输出本身，**不含** `BASH_RESULT[...]` / `Assertions:` / `Interpretation:` / `stdout:` 包装；退出码与耗时出现在标题；
2. 触发一条非 0 退出的命令（如 `ls /nonexistent`），确认错误输出完整可见、未被吞；
3. 连续两次发送完全相同的短消息，确认两条气泡都出现；
4. 桌面与移动视口各验一次布局（工具卡片换行与徽标）。

### 决策记录

`docs/notes/implemented/2026-09-16-chat-presentation-polish.md`

`## Alternatives considered`：
- **在后端去掉信封、直接把 stdout 作为工具结果** — 落选：信封里的 `Assertions` 是给模型的证据（`bash.ts:53` 明确要求模型读 `retrieved_data_available`），后端去掉会削弱模型侧判据
- **移植上游 `UnifiedToolCall.tsx` 整个组件** — 落选：它依赖 Sati 没有的 `toolDisplay.*` i18n 命名空间与 `toolConfigs` 的 collapsible 契约，Sati 的 `ToolRenderer` 结构不同（含 `ContentRenderers` / `InteractiveRenderers`）
- **用户消息去重改为完全移除** — 落选：会重新引入"乐观气泡与已落盘消息重复"的原问题

---

## 三、全局门禁与交付纪律

每项 PR 结束前统一执行（AGENTS.md 规则 9 + 规则 7）：

```bash
pnpm check                      # check:config + typecheck（含 ui）+ lint + format:check
pnpm check:protocol-version     # P4 专项
pnpm gen:event-matrix           # P2 若 check:event-matrix 报红则跑，随后 pnpm check:event-matrix
pnpm test                       # 完整后端套件（先 build）
pnpm --filter sati-ui test      # UI + ui/server 套件
```

- **提交**：Conventional Commits，每条分支一次 PR（main 受保护）。
- **决策记录**：P1–P6 各需一条 `docs/notes/implemented/2026-09-16-*.md`，必含 `## Alternatives considered`。实施计划本身（本文件）按 `docs/notes/README.md` 的纪律属于 `docs/*-plan.md` 而非 note——落地时建议一并落为 `docs/pilotdeck-2026-09-upstream-port-plan.md`，note 只记"决策背景 + 放弃物 + 后果"。
- **事件面**：只有 P2 触碰 `AgentEvent`（`compact_completed.status` 类型收窄），P4 只增帧的可选字段。改后 `pnpm check:event-matrix` 必须 green。
- **i18n**：P2、P6 的用户可见文案必须在 `ui/src/i18n/locales/{en,zh-CN}/` 双写（规则 4）。
- **重放 fixture**：本批**六项均不触碰工具 `inputSchema`，也不改变请求内容哈希**，因此不触发 fixture 重录（规则 6）。若实现过程中发现需要改 schema，须停下来重新评估。

## 四、非目标（明确不做，避免范围蔓延）

| 项 | 理由 |
|---|---|
| #574 删除文本→工具调用兜底（−1299 行） | 产品契约变更而非缺陷修复。Sati 在 `AgentLoop.ts:636-654` 依赖 `hasUnparsedTextToolCall` 触发自纠重试。应作为独立决策（显式开关 + 观测）而非静默删除 |
| #574 删除 `thinkFsm` / `splitThinkContent` | Sati 的 `thinking/registry.ts` 明确覆盖 kimi / deepseek-v4 / qwen / glm 等"OpenAI 兼容端点把推理内联在 content"的场景，照删会回归 |
| #587 删除 temperature | `src/patent/clarity/` 依赖 temp 0.1 确定性打分 |
| 完整时间线协议（`previousId` 链 / `offset` 间隔恢复 / UI store 重写） | 需网关协议升版并重写 `ui/src/stores/useSessionStore.ts` 约 400 行合并逻辑；P4 的绝对投影已消除本批目标的症状 |
| #585 项目侧栏（18 文件 +1226 行） | 子系统已分叉（Sati 是 `ui/server/services/projects-watcher.js`，无 `projectUpdateScheduler.js` / `projectActivity`，`useProjectsState.ts` 无 activity 概念）。**应先复现症状再决定**，待验两条：新建 workspace 后侧栏是否延迟可见；删除项目后分页总数是否重复递减 |
| #591 代码块主题适配 | 缺陷在 Sati 不存在：`ui/src/components/chat/view/.../MarkdownCodeBlock.tsx:27,54` 已是主题自适应 |
| #586 模型选择器按 provider 分组 | 纯 UI 分组，价值低且取决于 Sati 模型目录是否带 provider 字段，可随时单独取 |
| #570 UploadStore 路径收敛与限速 | Sati 已是分叉实现（用户级临时目录 + `sanitizeAttachmentFilename`），无 `src/gateway/dialog/UploadStore.ts` |

## 五、执行顺序建议

P1（3 行，先清掉一个真实崩溃）→ P2（压缩终态，含陷阱项）→ P3-0（UI 写侧回归修复，本身可独立发布）→ P3（语义翻转 + 迁移守卫）→ P4（绝对投影 + 协议 1.9）→ P5（不静默夹取）→ P6（展示层小修）。

P1、P5、P6 相互独立，可与 P2–P4 并行推进。

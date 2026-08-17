# Sati 性能卡点分析报告

> 项目路径：`/Users/xujian/projects/Sati`  
> 规模：~164K 行 TypeScript  
> 分析日期：2026-08-17

---

## 总览

| 严重度 | 数量 | 说明 |
|--------|------|------|
| **P0 — 关键瓶颈** | 5 | 直接阻塞事件循环或每轮重复执行，长对话下延迟可达数秒 |
| **P1 — 高影响** | 7 | 热路径中的 O(n²) 或 O(n) 冗余操作 |
| **P2 — 中等影响** | 8 | 工具执行路径同步 I/O、内存泄漏、缓存缺失 |
| **P3 — 低影响** | 6 | 冷路径同步 I/O、轻微优化点 |

---

## P0 — 关键性能瓶颈

### 1. Token 计数无缓存 + 同步阻塞事件循环

**文件**: `src/context/budget/tokenizer.ts:17-19` + `src/context/budget/TokenBudgetManager.ts:165-171`

```typescript
// tokenizer.ts — 纯同步 CPU 密集
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getTokenizer().encode(text).length;  // 阻塞！
}

// TokenBudgetManager.ts — 每轮全量遍历，零缓存
estimateForMessages(messages: CanonicalMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += this.estimateForMessage(message);  // 内部调 countTokens
  }
  return total;
}
```

**问题**：
- `js-tiktoken` 的 `encode()` 是纯同步 CPU 密集操作，项目注释自评 **100KB 文本约 8 秒**
- `TokenBudgetManager` 对每条消息重新编码 token，**无任何缓存**
- 随对话增长，每轮都要重新编码所有旧消息的 token（即使内容从未改变）
- 10 轮对话后，每轮的 token 计数开销是第 1 轮的 10 倍

**影响**：长对话场景下，每轮模型请求前阻塞事件循环数秒。

---

### 2. 同一请求 Token 计数重复执行 3 次

**文件**: `src/context/budget/TokenAccountingRuntime.ts:123,131,142-143`

```typescript
// 第 1 次 — fast-path 检查
const localTokens = this.estimateRequestInput(request, { usePadding });  // 行 123

// 第 2 次 — displayTokens（参数不同：无 padding）
displayTokens: usePadding ? this.estimateRequestInput(request) : undefined,  // 行 131

// 慢路径中第 3、4 次
displayTokens: counted.exact ? undefined : this.estimateRequestInput(request),  // 行 142
budgetTokens: usePadding ? this.estimateRequestInput(request, { usePadding: true }) : undefined,  // 行 143
```

**问题**：fast-path 调用 2 次，slow-path 调用 3 次，每次都全量 tiktoken 编码。行 123 和行 143 参数完全相同（`usePadding: true`），是纯粹重复计算。

**影响**：tiktoken 开销 ×3。

---

### 3. 压缩过程中 4 次全量 Token 扫描

**文件**: `src/context/compaction/CompactionEngine.ts`

| 行号 | 调用 | 说明 |
|------|------|------|
| 143 | `estimateMessages(input.messages)` | 压缩前全量计数 |
| 154 | `estimateTurnTokens(turnMessages)` | 每个 turn 分组计数（内部多次调用） |
| 157 | `estimateMessages(compactPlan.messagesToKeep)` | 保留部分计数 |
| 260 | `estimateMessages(buildPostCompactMessages(result))` | 压缩后全量计数 |

**问题**：每次 `estimateMessages` 都同步遍历消息并执行 tiktoken 编码，压缩过程中至少 4 次全量扫描。

**影响**：压缩触发时长时间阻塞（与对话长度成正比），且 `runAutoCompact` 每轮可能调用最多 3 次（pre-routing、post-routing、model-error-recovery）。

---

### 4. 每轮深度克隆全部消息

**文件**: `src/agent/loop/AgentLoop.ts:1827`

```typescript
messages: cloneMessages(requestMessages),  // 每轮调用
```

`cloneMessages`（`src/model/protocol/clone.ts:49`）对每条消息的每个 `tool_call` 块调用 `structuredClone(tc.input)`。

**问题**：
- 每轮都深度克隆整个消息历史，开销随对话长度线性增长
- 预算评估器（`createBudgetEvaluator`）会再次调用 `createModelRequest`，导致同一轮内克隆 **2 次**
- 每轮可能调用 `createModelRequest` 最多 4 次（pre-routing + post-routing + error-recovery + budget evaluator）

**影响**：O(n) CPU + 内存分配每轮，对话越长越严重。

---

### 5. 路由统计 — 每次请求同步写入磁盘

**文件**: `src/router/stats/TokenStatsCollector.ts:199-209`

```typescript
private appendRecord(record: RouterStatsRecord): void {
  const line = JSON.stringify(record) + "\n";
  try {
    if (this.fd !== undefined) {
      fs.writeSync(this.fd, line);           // 同步写！
    } else if (this.jsonlPath) {
      fs.appendFileSync(this.jsonlPath, line, "utf-8");  // 同步写！
    }
  } catch { /* best-effort */ }
}
```

**问题**：`observe()` 在每次路由请求时调用 → `appendRecord()` 使用 `fs.writeSync`。这是请求级热路径，每次路由都阻塞事件循环做磁盘 I/O。

**额外问题**：排序比较器内调用 `JSON.parse`（行 413-415），O(n log n) 次 JSON.parse。

---

## P1 — 高影响

### 6. SSE 流解析中的字符串拼接 O(n²)

**文件**: `src/model/streaming/streamModel.ts:865`

```typescript
buffer += decoder.decode(value, { stream: true });  // O(n²) 字符串拼接
```

每个 SSE chunk 到达都做 `buffer +=`，字符串不可变需全量复制。长流式响应（数千 token）累积后，每次拼接开销线性增长。

**同类问题**：
- `StreamingCheckpoint.ts:25` — `partialText += event.text`
- `CompactionEngine.ts:332` — `text += event.text`（摘要可达 20K token）
- `gateway/server/websocket.ts:77` — `Buffer.concat([this.buffer, chunk])`

---

### 7. 向量搜索 — 暴力扫描 + 循环内排序

**文件**: `src/knowledge/shared/int8-matrix-search.ts:164-194`

```typescript
for (const [docId, range] of data.docOffsets) {     // 遍历所有文档
  for (let i = range.start; i < range.end; i++) {   // 遍历所有 chunk
    for (let j = 0; j < data.dimensions; j++) {     // 遍历 1024 维
      dot += query[j] * data.vectors[base + j];
    }
    // ...
    result.sort((a, b) => b.score - a.score);  // 每找到候选就全排序！
  }
}
```

**问题**：
- 已有 Hölder 剪枝，但最坏情况仍是 O(docs × chunks × 1024)
- 循环内 `result.sort()` — 每找到一个候选就对整个结果数组重新排序，应使用最大堆或二分插入

**影响**：知识检索延迟在语料增长后线性退化。

---

### 8. 向量矩阵全量加载到内存（~147MB/corpus）

**文件**: `src/knowledge/shared/knowledge-embeddings.ts:149-197` + `src/knowledge/shared/vector-db.ts:43`

```typescript
// vector-db.ts — 缓存无上限
private readonly cache = new Map<string, Int8ChunkMatrix>();  // 无 LRU
```

**问题**：
- 约 144K chunk × 1024 维 × 1 byte(int8) = ~147MB / corpus
- `vector-db.ts` 的 `cache` Map 无 LRU 上限，多 corpus 场景内存无限膨胀
- `vector-index.ts` 的 `entries` Map 同样无 LRU
- `kg-store.ts` 的 `nodeCache` 无 TTL / 无淘汰（图谱达 116K 节点）

---

### 9. PostgreSQL — 每次调用创建/销毁连接 + 串行查询

**文件**: `src/cli/commands/patentSearch.ts:522-544`

```typescript
const client = new pg.Client({...});  // 每次新建连接
await client.connect();                 // TCP 握手 + 认证
// ... 12 个查询分支串行执行 ...
await client.query(query.text, query.values);  // 无 prepared statement
await client.end();                     // 每次销毁连接
```

**问题**：
- 使用 `pg.Client` 而非 `pg.Pool`，无连接复用
- 12 个查询分支串行执行，无 `Promise.all` 并行
- 无 prepared statement，每次重新生成执行计划

---

### 10. SQLite — 全表扫描 + 无分页 + N+1 查询

**文件**: `src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts`

| 行号 | 问题 |
|------|------|
| 310 | `SELECT * FROM l0_sessions ORDER BY ...` — 无 WHERE 无 LIMIT，全表扫描 |
| 814-828 | `repairL0Sessions` — 全量加载后循环逐条写入，无事务包裹 |
| 294 | `SELECT * ... WHERE indexed = 0` — 无 LIMIT |

**额外**：`vector-db-writer.ts:138-156` 逐条 INSERT 无事务，批量写入 N 个 chunk = N 次 fsync。

---

### 11. JSON.parse(JSON.stringify()) 深拷贝在事件流热路径

**文件**: `src/gateway/client/eventMapping.ts:27`

```typescript
JSON.parse(JSON.stringify(event))  // 每个网关事件都深拷贝
```

**影响**：每个网关事件（包括高频的 `text_delta`）都执行序列化 + 反序列化，应使用 `structuredClone` 或浅拷贝。

---

### 12. 网关静态资源 — 每请求 4 次同步 fs 调用

**文件**: `src/gateway/server/staticAssets.ts:20-21`

每个 HTTP 静态资源请求都执行 `existsSync` + `statSync`（各两次），阻塞事件循环。

---

## P2 — 中等影响

### 13. AgentLoop — 冗余遍历

| 文件 | 行号 | 问题 |
|------|------|------|
| `AgentLoop.ts` | 709, 754, 1088 | `filter(m => m.role === "assistant").at(-1)` — 三处 O(n) 扫描找最后一条 assistant 消息 |
| `AgentLoop.ts` | 1800-1814 | 每轮 `list().filter().filter().map()` 重建工具 schema，工具列表极少变化 |
| `AgentLoop.ts` | 2065 | `new Set(registry.list().map(...))` 每次重建工具名集合 |
| `PlanTodoState.ts` | 129-144 | 同一数组 5+ 次独立 `.map()/.filter()` 遍历 |

---

### 14. 事件监听器泄漏（重连场景）

| 文件 | 行号 | 问题 |
|------|------|------|
| `qqbot-gateway.ts` | 71-92 | 重连时旧 WS 的 4 个监听器不清理 |
| `QQChannel.ts` | 67-102 | 9 个 EventEmitter 监听器 `stop()` 时不移除 |
| `GatewayWsClient.ts` | 72-73 | message/close 监听器重连后残留 |
| `websocket.ts` | 21-23 | socket 监听器 `close()` 时不移除 |
| `WeComChannel.ts` | 317-332 | WS 监听器重连时泄漏 |
| `MattermostChannel.ts` | 114-120 | 同一处理函数通过两种 API 注册两次 |

---

### 15. 工具执行路径中的同步 I/O

| 文件 | 行号 | 调用 |
|------|------|------|
| `PluginToToolBridge.ts` | 186 | `readFileSync(absPath)` — 图片读取 |
| `planMode.ts` | 225 | `readFileSync` — 计划文件 |
| `patentPdfDownload.ts` | 84 | `readFileSync` |
| `chart.ts` | 254 | `readFileSync` — 循环内 |
| `pdf-extract.ts` | 223 | `readFileSync` — 整个 PDF 到内存 |
| `WeixinChannel.ts` | 1042-1069 | 消息处理路径中的 `existsSync`+`readFileSync`+`rmSync` |

---

### 16. 消息处理 fire-and-forget 吞错误

| 文件 | 行号 | 问题 |
|------|------|------|
| `AgentLoop.ts` | 368, 1836 | `.catch(() => {})` — 生命周期事件错误被吞 |
| `TurnRunner.ts` | 160, 365, 450 | 转录记录 fire-and-forget |
| `QQChannel.ts` | 99, 104 | `void this.handleGroupMessage()` — 处理失败无感知 |
| `WhatsAppChannel.ts` | 97 | 轮询 fire-and-forget，可能重叠执行 |

---

### 17. 缓存无 TTL / 无失效

| 文件 | 行号 | 问题 |
|------|------|------|
| `law-search-tool.ts` | 34 | 模块级单例缓存，DB 文件替换后仍指向旧句柄 |
| `kg-store.ts` | 39 | `nodeCache` 无 LRU，116K 节点缓存无上限 |
| `vector-db.ts` | 43 | `cache` Map 无 LRU，多 corpus 内存膨胀 |

---

### 18. SSE 流解析无 try/catch

**文件**: `src/model/streaming/streamModel.ts:899`

```typescript
JSON.parse(data)  // 无 try/catch，格式错误的数据包中断整个流
```

---

### 19. 嵌套循环 — 知识图谱遍历

**文件**: `src/knowledge/patent/patent-kg-adapter.ts:76-110`

三重嵌套：`for (hits) { for (relations) { for (neighbors) } }` — 图遍历扩展。

---

### 20. 路由每请求遍历全部消息

**文件**: `src/router/utils/mediaRequirements.ts:13-14` + `countTokens.ts:8-9`

```typescript
for (const message of messages) {    // 遍历所有消息
  for (const block of message.content) {  // 遍历所有块
```

每次路由请求都全量扫描消息历史收集媒体需求和 token 计数。

---

## P3 — 低影响

| # | 位置 | 问题 |
|---|------|------|
| 21 | `parseTextToolCalls.ts:88-89` | 全局正则在完整文本上重复扫描 |
| 22 | `embedding-consistency.ts:76` | `ORDER BY RANDOM()` 全表排序 |
| 23 | `wiki-card-loader.ts` | 首次加载约 1548 次 `readFileSync`（有缓存） |
| 24 | 各配置/规则加载器 | 启动时同步 I/O（仅执行一次） |
| 25 | `case-law-search.ts:392` | 带过滤条件时动态 prepare SQL |
| 26 | `personal-note-store.ts:44-53` | `list()` 无 LIMIT 分页 |

---

## 修复优先级建议

### 第一批（收益最高，改动集中）

1. **Token 计数缓存** — 给 `TokenBudgetManager` 加 message-level token 缓存（key = 消息内容 hash），旧消息不再重复编码。预期长对话每轮延迟降低 **80%+**。

2. **消除重复 Token 计数** — `evaluateRequestBudget` 中缓存 `estimateRequestInput` 结果，同一请求只算一次。预期 **3x** 提升。

3. **TokenStatsCollector 异步化** — `writeSync` → 缓冲 + 批量异步 `fs.appendFile`。消除每请求磁盘阻塞。

4. **SSE 字符串拼接 → 数组 join** — `streamModel.ts`、`StreamingCheckpoint.ts`、`CompactionEngine.ts`、`websocket.ts` 四处统一改为 `string[]` 累积 + `join()`。

### 第二批（中等改动）

5. **向量搜索循环内排序 → 二分插入** — `int8-matrix-search.ts` 用二分插入替代 `result.sort()`。

6. **cloneMessages 优化** — 评估是否需要完整深拷贝，或改用不可变更新模式避免每轮全量克隆。

7. **pg.Client → pg.Pool** — 专利搜索使用连接池 + prepared statements + 查询分支并行化。

8. **vector-db cache 加 LRU** — 限制内存使用，复用现有 `TtlCache` 模式。

### 第三批（清理类）

9. **事件监听器泄漏修复** — 所有 channel adapter 的 `stop()` 方法添加 `removeAllListeners()` / `removeEventListener()`。

10. **工具路径同步 I/O → 异步** — `readFileSync` → `fs.promises.readFile`。

11. **SQLite 批量写入加事务** — 参考 `knowledgeNoteSave.ts` 的正确实现。

---

*报告生成于 2026-08-17，基于静态代码分析，未包含运行时 profiling 数据。建议结合实际负载做性能验证。*

# Wiring Gaps 全量修复方案

参考：`docs/wiring-gaps.md`（16 条 wiring fail 清单），`tests/wiring/feature-wiring.test.ts`（验收标准）。

执行原则：

1. **按"焊点"分波**：同一焊点上的活儿合并到一波，不重复进出文件。
2. **先扩接口、再焊电线、最后接末端**：契约 → wiring → 测试升级。
3. **接口扩展尽量保持 optional，不破坏现有调用**（router 改动刚 land，避免再触发同事 merge 冲突）。
4. **A2 / B1.channel 是两个"协议级 deferred"**：A2 真 tokenizer 还没实现，只能 partial；B1 channel 需要 Gateway 协议加事件，是独立 PR。这两条给 documented partial fix（test 改 `skip` 并附 reason）。
5. **每波单独 commit + npm test 全绿后才进下一波**。

---

## 阶段 0 — 协调与契约对齐（先做，~30 min）

### 0.1 跟同事过一遍接口变更（必须，不然又会 conflict）

待加字段，全部 optional：

```ts
// src/agent/runtime/AgentRuntimeDependencies.ts
export type AgentRuntimeDependencies = {
  router: AgentRouterRuntime;
  tools: { scheduler: PolitDeckToolScheduler; registry: ToolRegistry };
  context?: AgentContextRuntime;
  now?: () => Date;
  uuid?: () => string;
  auditRecorder?: PolitDeckToolAuditRecorder;
  lifecycle?: LifecycleRuntime;
  subagentTranscript?: AgentSubagentTranscriptHooks;

  // ADD ↓
  elicitation?: PolitDeckElicitationChannel;
  fileHistory?: PolitDeckToolFileHistorySink;
  // mcpRuntime / backgroundTasks 不进 deps —— 它们的产出已经走 tools.registry 了
};
```

```ts
// src/context/ContextRuntime.ts
export type AgentContextRuntime = {
  prepareForModel(input): Promise<AgentPreparedContext>;
  recoverFromModelError?(input): Promise<ContextRecoveryDecision>;
  // ADD ↓
  applyToolResults?(input: AgentApplyToolResultsInput): Promise<AgentApplyToolResultsResult>;
  captureTurn?(input: AgentCaptureTurnInput): Promise<void>;
};
```

```ts
// src/polit/config/types.ts — 新增可选 context section
export type PolitContextConfig = {
  cachedMicrocompactEnabled?: boolean;        // A4 gate
  autoCompactionEnabled?: boolean;             // A5 gate
  toolResultBudgetMaxChars?: number;          // budget threshold
};
export type PolitConfig = {
  // ...
  context?: PolitContextConfig;
};
```

**对齐要点**：

- 跟同事确认 `dependencies.elicitation` 不会跟他即将做的 cron / always-on 协议冲突（cron 自己 controller 走 `cron:`，不冲）。
- `applyToolResults` / `captureTurn` 都是 context runtime 内部能力，他不动 context，不冲。
- `context.cachedMicrocompactEnabled` 等三个 flag 默认 `false`，对他现有路径无副作用。

### 0.2 给 createLocalGateway 加 test 注入点（不可避免，否则 R5 跑不动）

```ts
export type CreateLocalGatewayOptions = {
  // ... 现有字段
  /**
   * 测试专用：替换 model runtime（避免实测时打真 API）。生产路径
   * 永远经过 createModelRuntime(snapshot.config.model)。
   */
  __testModelFactory?: (config: ModelConfig) => ModelRuntime;
};
```

只要在 `ProjectRuntimeRegistry.resolve()` 里：`const model = options.__testModelFactory?.(snapshot.config.model) ?? createModelRuntime(snapshot.config.model);`

---

## 阶段 R1 — 纯注册（最低风险，30 min）

**焊点**：`createBuiltinRegistry`、`createLocalGateway`。

**修复项**：

| ID | 改动 |
|---|---|
| **A3** structured_output | `createBuiltinRegistry`：默认 register `createStructuredOutputTool()`；加 `structuredOutput?: false` 选项允许关掉 |
| **B1.tool** ask_user_question | `createBuiltinRegistry`：默认 register `createAskUserQuestionTool()`；加 `askUserQuestion?: false` 关掉 |

**改动文件**：

```
M  src/tool/registry/createBuiltinRegistry.ts  +20 lines
```

**测试升级**：

```
tests/tool/builtin-registry.test.ts  → 加 2 个新名字检查
tests/wiring/feature-wiring.test.ts → A3 / B1.tool 自动转绿
```

---

## 阶段 R2 — Per-project runtimes（中风险，~2 小时）

**焊点**：`ProjectRuntimeRegistry.resolve()`（per-project 单例）。

### R2.1 BackgroundTaskRuntime（C5）

```ts
// src/cli/createLocalGateway.ts ProjectRuntimeRegistry.resolve()
const backgroundTasks = new BackgroundTaskRuntime({
  diskSpillDir: path.join(this.options.politHome, "tasks", projectKey),
  now: this.options.now,
});
const tools = createBuiltinRegistry({
  backgroundTasks: { runtime: backgroundTasks },
});
```

shutdown：Gateway close 时调 `backgroundTasks.killAll()`，需要 Gateway protocol 加 `dispose()` 钩子（如果还没有）。

### R2.2 EdgeClawMemoryProvider（memory.provider）

```ts
import { EdgeClawMemoryService } from "../../third-party/edgeclaw-memory-core/lib/service.js";
import { EdgeClawMemoryProvider } from "../context/index.js";

let memoryResolver: MemoryResolver | undefined;
const memCfg = snapshot.config.memory;
if (memCfg?.enabled && memCfg.provider === "edgeclaw") {
  const memoryService = new EdgeClawMemoryService({
    workspaceDir: projectRoot,
    rootDir: memCfg.rootDir ?? path.join(this.options.politHome, "memory"),
    captureStrategy: memCfg.captureStrategy,
    includeAssistant: memCfg.includeAssistant,
    maxMessageChars: memCfg.maxMessageChars,
    llm: memCfg.llm,
    source: "politdeck",
  });
  memoryResolver = new EdgeClawMemoryProvider({
    service: memoryService,
    retrievalMode: "auto",
    source: "politdeck",
    now: this.options.now,
  });
  // 缓存到 ProjectRuntime, dispose() 时调 memoryService.close()
}
```

### R2.3 McpRuntime（C1）

```ts
const mcpServerSpecs = collectMcpServerSpecsFromPlugins(pluginRuntime);  // helper：从 plugin manifest 拉 MCP spec
let mcpRuntime: McpRuntime | undefined;
if (mcpServerSpecs.length > 0) {
  mcpRuntime = new McpRuntime(mcpServerSpecs, {
    now: this.options.now,
  });
  const mcpToolDefs = await createMcpToolDefinitionsFromRuntime(mcpRuntime);
  for (const def of mcpToolDefs) {
    tools.register(def);
  }
}
// 缓存到 ProjectRuntime, dispose() 时调 mcpRuntime?.shutdown()
```

注意：`createMcpToolDefinitionsFromRuntime` 是 async，意味着 `resolve()` 也要 async。这是结构性变更——`resolve()` 现在返回 `Promise<ProjectRuntime>`，所有 caller 要 `await`。

**ProjectRuntime 扩 fields**：

```ts
type ProjectRuntime = {
  // ... 现有
  backgroundTasks: BackgroundTaskRuntime;
  memoryService?: EdgeClawMemoryService;
  memoryResolver?: MemoryResolver;
  mcpRuntime?: McpRuntime;
  dispose(): Promise<void>;
};
```

---

## 阶段 R3 — Per-session context runtime（中风险，~2 小时）

**焊点**：`ProjectRuntimeRegistry.createSession()`。

### R3.1 ToolResultBudget

```ts
const toolResultBudget = new ToolResultBudget({
  toolResultsDir: path.join(this.options.politHome, "tool-results", context.sessionKey),
  maxResultSizeChars: snapshot.config.context?.toolResultBudgetMaxChars ?? 100_000,
});
```

### R3.2 CachedMicroCompactionEngine（A4）

```ts
const cachedMicroCompaction = snapshot.config.context?.cachedMicrocompactEnabled
  ? new CachedMicroCompactionEngine({ enabled: true })
  : undefined;
```

### R3.3 CompactionEngine + AutoCompactionPolicy（A5）

```ts
const autoCompaction = snapshot.config.context?.autoCompactionEnabled
  ? new AutoCompactionPolicy({ tokenBudget: new TokenBudgetManager() })
  : undefined;
const compactionEngine = autoCompaction
  ? new CompactionEngine({ /* ... */ })
  : undefined;
```

### R3.4 FileHistoryStore（C4）

```ts
const fileHistoryStore = new FileHistoryStore({
  backupDir: path.join(this.options.politHome, "file-history", context.sessionKey),
  maxSnapshots: 32,
});
```

### R3.5 把所有产物喂给 DefaultContextRuntime

```ts
const contextRuntime = new DefaultContextRuntime({
  extension: new PluginRuntimeExtensionResolver(runtime.pluginRuntime),
  projectRoot: runtime.projectRoot,
  now: this.options.now,
  memoryResolver: runtime.memoryResolver,         // R2.2
  toolResultBudget,                                // R3.1
  // cachedMicroCompaction / autoCompaction —— DefaultContextRuntime 暂不直接消费,
  // 留 R3.6 给 AgentLoop 在 turn 边界调度（参见接口扩展）
});
```

### R3.6 把 sidechain hooks / fileHistory / elicitation 织进 deps

```ts
const subagentTranscript = createSubagentTranscriptHooks({
  parentTranscript: storage.transcriptPath,
  subagentTranscriptPath: storage.subagentTranscriptPath,
});

const dependencies: AgentRuntimeDependencies = {
  router: runtime.router,
  tools: { registry: runtime.tools },
  context: contextRuntime,
  lifecycle,
  now: this.options.now,
  subagentTranscript,                              // C3
  fileHistory: fileHistoryStore.toSink(),         // C4
  // elicitation 暂留 undefined（R5 给 InMemoryElicitationChannel 占位 / adapter 后续）
};
```

---

## 阶段 R4 — AgentLoop 接口扩展（高谨慎，~3 小时）

**焊点**：`AgentLoop`、`AgentContextRuntime`、`DefaultContextRuntime`。

### R4.1 接口加字段

`src/context/ContextRuntime.ts` 加：

```ts
export type AgentApplyToolResultsInput = ContextToolResultInput;
export type AgentApplyToolResultsResult = ContextToolResultResult;

export type AgentCaptureTurnInput = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  errored: boolean;
};

export type AgentContextRuntime = {
  prepareForModel(input): Promise<AgentPreparedContext>;
  recoverFromModelError?(input): Promise<ContextRecoveryDecision>;
  applyToolResults?(input: AgentApplyToolResultsInput): Promise<AgentApplyToolResultsResult>;
  captureTurn?(input: AgentCaptureTurnInput): Promise<void>;
};
```

### R4.2 DefaultContextRuntime 实现 captureTurn

```ts
async captureTurn(input: AgentCaptureTurnInput): Promise<void> {
  if (!this.memoryResolver) return;
  await this.memoryResolver.captureTurn({
    sessionId: input.sessionId,
    messages: input.messages,
  });
}
```

`applyToolResults` 已实现，无变化。

### R4.3 AgentLoop 调用新钩子

- 每次拿到 tool result（`projectToolResults` 之后），调 `await contextRuntime.applyToolResults?.({ messages, toolResultMessage })`，把返回的 `messages` 替换。
- 每次 `turn_completed` 之前：

```ts
try {
  await contextRuntime.captureTurn?.({
    sessionId: input.sessionId,
    turnId: input.turnId,
    messages,
    errored: result.type === "error",
  });
} catch {
  // capture 失败不能 break turn —— 落 diagnostic
}
```

### R4.4 AgentLoop.createToolContext 完整化

```ts
return {
  sessionId: input.sessionId,
  turnId: input.turnId,
  cwd: this.config.cwd,
  abortSignal: input.abortSignal,
  permissionMode: this.config.permissionMode,
  permissionContext: this.config.permissionContext,
  auditRecorder: this.dependencies.auditRecorder,
  now: this.now,
  env: this.config.env,
  maxResultBytes: this.config.maxResultBytes,
  model: { stream: ... },               // 已有
  subagentDepth: this.config.subagentDepth ?? 0,
  subagent: this.buildSubagentForkApi(input, messages),
  // ADD ↓
  elicitation: this.dependencies.elicitation,
  fileHistory: this.dependencies.fileHistory,
  messageId: input.turnId,             // 简化：用 turnId 做分组键，per-message UUID 是后续 polish
};
```

---

## 阶段 R5 — A2 / B1.channel 的 partial fix（30 min）

### R5.1 A2 real tokenizer

A2 文档明说 partial（`context-real-tokenizer deferred → partial（API count 仍未启用）`）。当前 `TokenBudgetManager` 只接受 `bytesPerToken`（静态除数），没有 provider tokenizer。**短期不修**。

action：

```ts
// tests/wiring/feature-wiring.test.ts
test.skip("WIRING A2 real tokenizer fallback ...", () => { ... });
```

附 comment：`A2 deferred per docs/politdeck-deferred-feature-implementation-guide.md (line 495). Re-enable when provider tokenizer service lands.`

### R5.2 B1.channel

`PolitDeckElicitationChannel.ts` 注释里说 Gateway 协议要加 `elicitation_request` / `elicitation_answer`，但目前 Gateway protocol 没这两个事件。

action（两个选项，二选一）：

**选项 A（推荐）**：补上 Gateway protocol 事件，但 channel 实现保持简单：

1. `src/gateway/protocol/types.ts` 加：
   ```ts
   GatewayEvent | { type: "elicitation_request"; requestId: string; question: string; options: ElicitOption[] };
   ```
2. Gateway 加方法 `respondElicitation(requestId, answer)`。
3. 实现 `GatewayElicitationChannel` 类，把 `askUser()` 转成事件 + Promise。
4. `createLocalGateway` 把它注入到 `dependencies.elicitation`。
5. 各 adapter（CLI/TUI/Feishu）后续再处理 UI 层。

**选项 B**：先注入 `InMemoryElicitationChannel`（永远抛 "no canned answer"），让 wiring test 过、实际功能 deferred。

我建议 **选项 A**，理由：

- 所有焊点都通了，只剩 adapter UI（明确的下游 PR）。
- Gateway 协议加事件是必经之路，越早越省。
- `GatewayElicitationChannel` 实现 ~50 行，跟 `permission_request` 同构。

---

## 阶段 R6 — 真 turn-driven integration test（升级 wiring test，~2 小时）

旧的 grep 风格 wiring test 改成真的跑 turn：

```
tests/wiring/runtime/memory-runtime.test.ts
tests/wiring/runtime/file-history-runtime.test.ts
tests/wiring/runtime/elicitation-runtime.test.ts
tests/wiring/runtime/background-task-runtime.test.ts
tests/wiring/runtime/mcp-runtime.test.ts
tests/wiring/runtime/tool-result-budget-runtime.test.ts
tests/wiring/runtime/compaction-runtime.test.ts
```

每个文件 pattern：

```ts
test("memory wired end-to-end", async () => {
  const fakeMemoryService = createFakeMemoryService();
  const fakeModel = createFakeModelRuntime({
    onRequest: (req) => {
      // 1) 断言 system prompt 含 <memory-context>
      assert.match(req.system, /<memory-context>/);
      // 2) 返回简单 text 让 turn 完成
      return scriptCompletedTurn();
    },
  });
  const gateway = createLocalGateway({
    projectRoot: tmpProj,
    politHome: tmpHome,
    __testModelFactory: () => fakeModel,
  });
  for await (const _ of gateway.submitTurn({ ... })) {}

  // 3) 断言 captureTurn 在 turn 结束后被调
  assert.equal(fakeMemoryService.captureCalls.length, 1);
});
```

旧的 grep test 全部 keep + skip + 加 comment "see runtime/<feature>.test.ts"，作为最后兜底。

---

## 提交策略

| Commit | 内容 | 测试要求 |
|---|---|---|
| `feat(wiring): R1 — register A3 / B1 builtin tools` | createBuiltinRegistry + 测试更新 | npm test 全绿 |
| `feat(wiring): R2 — per-project runtimes (BG tasks, MCP, memory)` | ProjectRuntimeRegistry 扩 | 全绿 |
| `feat(wiring): R3 — per-session context wiring (budget, sidechain, file history)` | createSession 扩 | 全绿 |
| `feat(wiring): R4 — AgentLoop calls applyToolResults / captureTurn / sets elicitation+fileHistory in tool context` | AgentLoop + AgentContextRuntime 接口 | 全绿 |
| `feat(wiring): R5 — Gateway elicitation events + channel bridge` | gateway protocol + GatewayElicitationChannel | 全绿 |
| `test(wiring): R6 — runtime-driven wiring tests + retire grep tests` | tests/wiring/runtime/* | 全绿 + 16 ❌ → 16 ✅ |

---

## 风险与协调点

1. **同事的 router 改动正在演进**：每波开工前先 `git fetch && git log HEAD..@{u}` 看一眼，避免再次冲突。
2. **`dependencies.elicitation` 跟 cron 的 controller 字段同层级**，名字不冲突；但都改 `AgentRuntimeDependencies`，建议跟同事说一声 R3+R4 这波要动。
3. **R4 改 `AgentContextRuntime` 接口**，全部 optional，不破坏 NullContextRuntime；但任何外部实现该接口的 adapter（如果有）也得加。grep 一下 `implements AgentContextRuntime`：目前只有 `DefaultContextRuntime` + `NullContextRuntime`，没问题。
4. **R2.3 改 `resolve()` 为 async**：是 breaking 但只在 createLocalGateway 内部调用，影响范围可控。
5. **A2 / B1.channel adapter UI** 走单独 PR 跟踪，不阻塞 R1-R4。

---

## 时间预算

| 阶段 | 估时 | 累计 |
|---|---|---|
| 0 协调 + 测试注入点 | 0.5 h | 0.5 h |
| R1 register 工具 | 0.5 h | 1.0 h |
| R2 per-project runtimes | 2 h | 3.0 h |
| R3 per-session wiring | 2 h | 5.0 h |
| R4 AgentLoop 接口扩展 | 3 h | 8.0 h |
| R5 Gateway elicitation 协议 | 1.5 h | 9.5 h |
| R6 runtime-driven tests | 2 h | 11.5 h |
| 整轮 npm test + 文档同步 + commit | 1 h | **~12.5 h** |

实际可能 +30%（merge 冲突 / typing 校正），算 **2 个 working day**。

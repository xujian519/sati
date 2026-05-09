# PolitDeck Session 重构代码开发文档

本文用于指导将 `third-party/claude-code-main` 中 session / transcript / resume / replay / storage 能力重构为 PolitDeck 顶层 `session` 模块。目标不是搬运 `sessionStorage.ts` 这个巨型文件，而是把 legacy 已验证的会话事实源、恢复语义、项目目录规则和轻量列表能力拆成清晰的 PolitDeck 模块。

本文件遵循 `.cursor/skills/refactor-with-parity` 的要求：不能声称“与旧实现行为一致”，除非存在同一套共享场景同时运行 legacy 和 PolitDeck 实现，并比较归一化输出。

## 1. 背景与边界

总方案 `docs/rewrite-plan/02-rewrite-project-report.md` 明确把 session 作为独立顶层模块：

```text
src/
  agent/
    session/
    turn/
    loop/

  context/

  session/
    transcript/
    resume/
    replay/
    storage/
```

依赖方向是：

```text
adapters
  -> agent
    -> session
```

因此：

- `agent` 负责 turn 编排、事件流、abort、调用 model/tool/context。
- `session` 负责持久化、resume、replay、session listing、metadata、migration。
- `context` 负责 compact、budget、attachments、memory 等上下文治理。

当前仓库已调整到这个方向：

```text
src/session/
  index.ts
  transcript/
    TranscriptWriter.ts
    InMemoryTranscriptWriter.ts
    JsonlTranscriptWriter.ts
    TranscriptEntry.ts
    TranscriptReader.ts
    TranscriptReplay.ts
  storage/
    ProjectSessionStorage.ts
  resume/
    resumeAgentSession.ts

src/context/
  ContextRuntime.ts
  NullContextRuntime.ts
```

但当前 `src/session/` 仍只是主 agent 的第一版持久化骨架，距离 legacy session 模块还有明显缺口。

## 2. Source Of Truth

重构时必须持续对照：

| 类型 | 路径 | 用途 |
| --- | --- | --- |
| 总方案 | `docs/rewrite-plan/02-rewrite-project-report.md` | session 顶层归属、依赖方向、运行流程 |
| 当前实现 | `src/session/` | PolitDeck session 当前状态 |
| 当前实现 | `src/agent/` | `AgentSession` 如何依赖 session |
| 当前实现 | `src/polit/paths.ts` | PolitDeck home、project chat 路径 |
| legacy 主实现 | `third-party/claude-code-main/src/utils/sessionStorage.ts` | JSONL transcript、metadata、resume、listing、sidechain、remote hydration |
| legacy portable | `third-party/claude-code-main/src/utils/sessionStoragePortable.ts` | SDK/listing 可用的轻量读取、路径 sanitize、跨 worktree 查找 |
| legacy resume | `third-party/claude-code-main/src/utils/sessionRestore.ts` | resume 后 AppState、worktree、agent、file history、attribution 恢复 |
| legacy listing | `third-party/claude-code-main/src/utils/listSessionsImpl.ts` | session list / pagination / head-tail lite metadata |
| legacy title | `third-party/claude-code-main/src/utils/sessionTitle.ts` | 会话标题生成和文本提取 |
| legacy activity | `third-party/claude-code-main/src/utils/sessionActivity.ts` | 远端 keepalive / activity heartbeat |
| 当前测试 | `tests/agent/`、`tests/polit/`、`tests/model/` | 现有 node:test 风格 |

## 3. 当前 PolitDeck Session 状态

当前已经有：

| Feature | 当前文件 | 状态 | 说明 |
| --- | --- | --- | --- |
| transcript writer interface | `src/session/transcript/TranscriptWriter.ts` | `compare` skeleton | 定义 accepted input、durable message、turn result 写入接口 |
| in-memory transcript | `src/session/transcript/InMemoryTranscriptWriter.ts` | `compare` skeleton | 用于测试和无持久化运行 |
| JSONL append writer | `src/session/transcript/JsonlTranscriptWriter.ts` | `compare` skeleton | 写入 sequence、createdAt、sessionId、turnId |
| transcript entry schema | `src/session/transcript/TranscriptEntry.ts` | `compare` skeleton | 当前仅覆盖主 agent durable entries |
| transcript reader | `src/session/transcript/TranscriptReader.ts` | `compare` skeleton | 按行解析 JSONL，收集 malformed diagnostics |
| transcript replay | `src/session/transcript/TranscriptReplay.ts` | `compare` skeleton | 重建 messages、usage、permission denials 和 replay events |
| project storage path | `src/session/storage/ProjectSessionStorage.ts` | `compare` skeleton | 使用 `getPolitProjectChatDir()` 生成 `<sessionId>.jsonl` |
| main session resume | `src/session/resume/resumeAgentSession.ts` | `compare` skeleton | 从 JSONL 恢复主 `AgentSession` |
| metadata store | `src/session/metadata/SessionMetadataStore.ts` | `compare` skeleton | 持久化 title、aiTitle、tag、PR link、mode |
| head-tail lite reader | `src/session/storage/SessionLiteReader.ts` | `compare` skeleton | 用于 listing 的 bounded head/tail read |
| project session listing | `src/session/storage/SessionList.ts` | `compare` skeleton | 支持 project scope、mtime sort、limit/offset |
| project path foundation | `src/polit/paths.ts` | `compare` partial | `~/.politdeck/projects/<projectId>/chats` |

### 实施进度（2026-05-09）

| Feature | Status | Notes |
| --- | --- | --- |
| parentUuid chain | ✅ resolved | `src/session/transcript/TranscriptChain.ts` — `buildConversationChain()` builds DAG, picks longest root→leaf path, appends orphans. Writer 已写 `entryId` / `parentEntryId` |
| compact boundary aware resume | ✅ resolved | `TranscriptReplay` `findLastCompactBoundaryIndex()` + replay 切片；Phase 1.5 `control_boundary` schema |
| metadata tail re-append | ✅ resolved | `SessionMetadataStore.reappendTail()` — 在 transcript tail 追加完整 metadata snapshot 供 lite reader 读 |
| resume restore metadata | ✅ resolved | `resumeAgentSession()` 返回 `metadata` + `SessionMetadataStore.restoreFromReplay()` 从 replay 种入内存 |
| listAllSessions | ✅ resolved | `listAllSessions({ politHome })` — 扫 `{politHome}/projects/*/chats/*.jsonl` |
| searchSessionsByTitle | ✅ resolved | `searchSessionsByTitle({ projectRoot, politHome, query })` — case-insensitive substring match on customTitle / aiTitle / firstPrompt |

当前还没有：

- sidechain / subagent transcript。
- file history / attribution / content replacement restore。
- remote hydration。
- worktree-aware lookup。
- migration layer。

## 4. Legacy 能力清单与缺口

### 4.1 Path 和 Project Directory

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| global projects dir | `getProjectsDir()` | `PolitHome/projects` | `compare` partial | PolitDeck 已有 project chat path，但目录层级是 `projects/<projectId>/chats` |
| project dir sanitize | `getProjectDir()` / `sanitizePath()` | `createProjectId()` | `intentional_difference` | Legacy 保留 Unicode 并处理长路径 hash；PolitDeck 当前简单替换非安全字符 |
| canonicalize project path | `canonicalizePath()` | `ProjectSessionStorage` | `deferred` | 需要 realpath + NFC，避免 symlink 导致同一项目多目录 |
| find project dir fallback | `findProjectDir()` | `ProjectSessionLocator` | `deferred` | 长路径 hash / Bun vs Node hash 兼容尚未实现 |
| worktree fallback lookup | `resolveSessionFilePath()` | `ProjectSessionLocator` | `deferred` | Git worktree 下查找同 repo sessions 尚未实现 |

### 4.2 Transcript Write

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| accepted user input before model | `QueryEngine` + `recordTranscript()` | `TurnRunner` + `AgentTranscriptWriter` | `compare` | 当前已测试 accepted input 先写 |
| append JSONL line | `appendEntryToFile()` | `JsonlTranscriptWriter` | `compare` partial | 当前异步 append，目录 `0o700`，文件创建 `0o600` |
| parentUuid chain | `insertMessageChain()` | `TranscriptChainWriter` | `deferred` | 当前有 `entryId` / `parentEntryId` 字段，但尚未用于 DAG/leaf resume |
| dedupe already-recorded messages | `getSessionMessages()` + messageSet | `TranscriptChainWriter` | `deferred` | 当前 writer 不做 UUID 去重 |
| progress excluded from chain | `isTranscriptMessage()` / `isChainParticipant()` | `TranscriptEntry` rules | `deferred` | 当前没有 progress entry 类型 |
| sidechain transcript | `recordSidechainTranscript()` | `session/transcript/sidechain` | `deferred` | subagent/fork 阶段实现 |
| queue operations | `recordQueueOperation()` | `session/event-log` | `deferred` | mid-turn command queue 未实现 |
| tombstone/remove message | `removeTranscriptMessage()` | `TranscriptMutationStore` | `deferred` | 当前没有逻辑删除 / tombstone |
| flush | `flushSessionStorage()` | `TranscriptWriter.flush()` | `deferred` | 当前 writer 串行 append，但无显式 flush |

### 4.3 Transcript Read / Resume

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| read JSONL transcript | `loadTranscriptFile()` | `readTranscript()` | `compare` skeleton | 当前逐行 JSON parse |
| max read bytes guard | `MAX_TRANSCRIPT_READ_BYTES` | `ReadTranscriptOptions.maxBytes` | `compare` | 当前默认 50MB，可配置 |
| build conversation chain | `buildConversationChain()` | `TranscriptChainReader` | `deferred` | 当前只是 sequence replay |
| recover parallel tool results | `recoverOrphanedParallelToolResults()` | `TranscriptChainReader` | `deferred` | legacy 对 streaming parallel tools 有专门恢复 |
| resume consistency metric | `checkResumeConsistency()` | `ResumeDiagnostics` | `deferred` | 当前只有 basic diagnostics |
| partial / malformed entry diagnostics | `loadTranscriptFile()` recovery paths | `readTranscript()` | `compare` partial | 当前 malformed line 有 diagnostics |
| incomplete turn handling | resume chain validation | `replayTranscriptEntries()` | `compare` skeleton | 当前跳过未完成 turn durable message |
| compact boundary aware load | compact boundary entries | `TranscriptReplay` + `context` | `deferred` | 当前不理解 compact boundary |
| content replacement restore | `recordContentReplacement()` / loader maps | `ToolResultBudgetState` | `deferred` | 依赖 context/tool result budget |

### 4.4 Metadata

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| custom title | `saveCustomTitle()` | `SessionMetadataStore` | `compare` skeleton | 当前可持久化 title，listing 优先 title |
| AI title | `saveAiGeneratedTitle()` | `SessionMetadataStore` | `compare` skeleton | 当前保留 user title wins 语义 |
| task summary | `saveTaskSummary()` | `SessionMetadataStore` | `deferred` | 依赖 background task |
| tag | `saveTag()` | `SessionMetadataStore` | `compare` skeleton | 当前可持久化并用于 listing |
| PR link | `linkSessionToPR()` | `SessionMetadataStore` | `compare` skeleton | 当前可写 metadata，适配器后续消费 |
| mode metadata | `saveMode()` | `SessionMetadataStore` | `compare` skeleton | 当前可写 metadata，coordinator/normal 语义后续 |
| worktree state | `saveWorktreeState()` | `SessionMetadataStore` | `deferred` | worktree phase |
| agent name/color/setting | `saveAgentName()` / `saveAgentColor()` / `saveAgentSetting()` | `SessionMetadataStore` | `deferred` | subagent/custom agent phase |
| metadata re-append | `reAppendSessionMetadata()` | `SessionMetadataStore.reappendTail()` | `deferred` | legacy 为 head-tail listing 保持 tail 可见 |
| restore metadata on resume | `restoreSessionMetadata()` | `resumeAgentSession()` | `deferred` | 当前只恢复 messages/usage/denials |

### 4.5 Session Listing / Search

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| list current project sessions | `fetchLogs()` / `getSessionFilesLite()` | `listProjectSessions()` | `compare` skeleton | 当前支持 project scope、mtime sort、limit/offset |
| list all projects | `loadAllProjectsMessageLogs()` | `listAllSessions()` | `deferred` | 需要扫描 `PolitHome/projects` |
| portable list sessions | `listSessionsImpl()` | `session/storage/listSessions.ts` | `deferred` | SDK/CLI shared reader |
| head/tail lite read | `readSessionLite()` | `readSessionLite()` | `compare` skeleton | 当前 64KB head/tail reader |
| pagination | `listSessionsImpl({ limit, offset })` | `listProjectSessions()` | `compare` skeleton | 当前 project-scope limit/offset |
| worktree inclusion | `includeWorktrees` | `listSessions()` | `deferred` | 依赖 git worktree detection |
| title search | `searchSessionsByCustomTitle()` | `searchSessions()` | `deferred` | metadata/search layer |
| agentic session search | `agenticSessionSearch.ts` | `session/search` | `deferred` | 需要 model-assisted search |

### 4.6 Restore Runtime State

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| file history restore | `fileHistoryRestoreStateFromLog()` | `session/restore/fileHistory` | `deferred` | 当前无 file history module |
| attribution restore | `restoreAttributionStateFromSnapshots()` | `session/restore/attribution` | `deferred` | 依赖 attribution module |
| todos from transcript | `extractTodosFromTranscript()` | `session/restore/todos` | `deferred` | Todo tool 未实现 |
| context collapse restore | `restoreFromEntries()` | `context.compaction` | `deferred` | context advanced phase |
| agent setting restore | `restoreAgentFromSession()` | `extension/agent` + `session` | `deferred` | custom agents 未实现 |
| worktree restore | `restoreWorktreeForResume()` | `worktree` + `session` | `deferred` | worktree phase |
| mode switch refresh | `refreshAgentDefinitionsForModeSwitch()` | `extension` + `session` | `deferred` | coordinator mode 未实现 |

### 4.7 Sidechain / Subagent / Remote

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| subagent transcript path | `getAgentTranscriptPath()` | `session/transcript/sidechain` | `deferred` | 需要 subagent runtime |
| agent metadata sidecar | `writeAgentMetadata()` / `readAgentMetadata()` | `session/storage/sidecar` | `deferred` | 记录 agentType/worktree/description |
| remote agent metadata | `writeRemoteAgentMetadata()` etc. | `session/remote` | `deferred` | remote/CCR phase |
| hydrate remote session | `hydrateRemoteSession()` | `session/remote` | `not_applicable` first phase | Adapter 层，不进入主 session core |
| CCR v2 internal events | `hydrateFromCCRv2InternalEvents()` | `session/remote` | `not_applicable` first phase | Remote adapter 后续 |

### 4.8 Activity / Keepalive

| Legacy feature | Legacy entrypoint | PolitDeck target | Status | Notes |
| --- | --- | --- | --- | --- |
| activity refcount | `startSessionActivity()` / `stopSessionActivity()` | `session/activity` | `deferred` | 当前无 remote keepalive |
| keepalive callback | `registerSessionActivityCallback()` | `session/activity` | `deferred` | remote adapter 阶段 |
| idle diagnostics | `session_idle_30s` | `session/activity diagnostics` | `deferred` | 可后续作为 observability |

## 5. Target Structure

目标目录：

```text
src/session/
  index.ts

  protocol/
    entries.ts
    metadata.ts
    diagnostics.ts
    errors.ts

  transcript/
    TranscriptWriter.ts
    JsonlTranscriptWriter.ts
    InMemoryTranscriptWriter.ts
    TranscriptReader.ts
    TranscriptChain.ts
    TranscriptReplay.ts
    TranscriptCompactionBoundary.ts

  storage/
    ProjectSessionStorage.ts
    ProjectSessionLocator.ts
    SessionLiteReader.ts
    SessionList.ts
    SessionSearch.ts

  resume/
    resumeAgentSession.ts
    restoreSessionState.ts
    ResumeDiagnostics.ts

  metadata/
    SessionMetadataStore.ts
    SessionTitle.ts
    SessionTags.ts
    SessionLinks.ts

  sidechain/
    SidechainTranscript.ts
    AgentMetadataStore.ts

  remote/
    RemoteHydration.ts

  activity/
    SessionActivity.ts
```

当前已存在的 `TranscriptEntry.ts` 可以后续移动到 `protocol/entries.ts`，但在文件较少时保留在 `transcript/` 也可以。关键是不要放回 `src/agent/`。

## 6. Public Protocol

### 6.1 Transcript Entry

PolitDeck entry 应稳定为 provider-neutral 结构：

```ts
export type AgentTranscriptEntry =
  | {
      type: "accepted_input";
      sessionId: string;
      turnId: string;
      sequence: number;
      createdAt: string;
      messages: CanonicalMessage[];
    }
  | {
      type: "assistant_message" | "tool_result_message" | "durable_message";
      sessionId: string;
      turnId: string;
      sequence: number;
      createdAt: string;
      message: CanonicalMessage;
    }
  | {
      type: "turn_result";
      sessionId: string;
      turnId: string;
      sequence: number;
      createdAt: string;
      result: AgentTurnResult;
    }
  | {
      type: "control_boundary";
      sessionId: string;
      turnId: string;
      sequence: number;
      createdAt: string;
      boundary: {
        kind: "compact" | "resume" | "manual";
        metadata?: Record<string, unknown>;
      };
    };
```

后续如果需要 parent chain，优先增加可选字段：

```ts
uuid?: string;
parentUuid?: string | null;
sourceToolAssistantUUID?: string;
```

不要把 Anthropic `BetaMessageParam` 写成 session 公共协议。

### 6.2 Session Metadata

建议新增：

```ts
export type SessionMetadata = {
  sessionId: string;
  projectRoot?: string;
  title?: string;
  aiTitle?: string;
  tag?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  createdAt?: string;
  updatedAt?: string;
  gitBranch?: string;
  mode?: "normal" | "coordinator";
  linkedPullRequest?: {
    number: number;
    url: string;
    repository: string;
  };
};
```

Metadata entry 必须遵循 user title 优先于 AI title。

### 6.3 Listing Result

```ts
export type SessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
};
```

该结构可对齐 legacy `listSessionsImpl.ts`，但命名使用 PolitDeck。

## 7. Runtime Flow

### 7.1 Write Flow

```text
AgentSession.submit(input)
  -> TurnInputProcessor.accept()
  -> session.transcript.recordAcceptedInput()
  -> AgentLoop.run()
  -> session.transcript.recordDurableMessage(assistant)
  -> session.transcript.recordDurableMessage(tool_result)
  -> session.transcript.recordTurnResult()
```

写入规则：

- accepted input 必须在 model request 前落盘。
- assistant/tool_result 是 durable messages，进入 replay。
- progress/model_event 默认不进入 durable chain。
- 写入失败返回 `agent_transcript_error`，不能静默继续。
- JSONL append 要串行化，避免同 turn 并发写乱序。

### 7.2 Resume Flow

```text
resumeAgentSession(sessionId, projectRoot)
  -> ProjectSessionLocator.resolve()
  -> TranscriptReader.read()
  -> TranscriptChain.rebuild()
  -> TranscriptReplay.toState()
  -> AgentSession(initialState)
```

当前 PolitDeck 已有 skeleton：

- `readTranscript()`
- `replayTranscriptEntries()`
- `resumeAgentSession()`

后续必须补：

- parent chain。
- leaf selection。
- compact boundary。
- metadata restore。
- partial-turn policy。

### 7.3 Listing Flow

```text
listSessions({ projectRoot, limit, offset })
  -> ProjectSessionLocator.findProjectDir()
  -> readSessionLite(head/tail)
  -> parseSessionInfoFromLite()
  -> sort by mtime
  -> apply pagination
```

不要全量读取所有 JSONL 才列表展示。

## 8. Implementation Order

### Phase 0：边界整理

已完成：

- `src/session/` 顶层模块存在。
- `src/context/` 顶层模块存在。
- `agent` 不再承载 JSONL writer/reader/resume 实现。

### Phase 1：主 transcript skeleton

已完成：

- JSONL writer。
- reader。
- replay。
- project chat path。
- resume main session。

仍需补：

- file mode `0o600` / dir mode `0o700`。
- max read bytes guard。
- corrupted line diagnostics 的更细分类。

### Phase 2：Chain 和 compact boundary

实现：

- UUID / parentUuid chain。
- `buildConversationChain()` 等价逻辑。
- parallel tool result recovery。
- compact boundary entry。
- resume consistency diagnostics。

测试：

- linear chain。
- branch / orphan recovery。
- malformed parent chain cycle。
- compact boundary 后只恢复有效上下文。

### Phase 3：Metadata

实现：

- custom title。
- AI title。
- tag。
- PR link。
- mode。
- worktree state skeleton。
- metadata re-append。

测试：

- user title wins over AI title。
- tail re-append 后 lite reader 能读取。
- resume restore metadata。

### Phase 4：Listing / Search

实现：

- `readSessionLite()`。
- `listSessions({ projectRoot, limit, offset })`。
- `listAllSessions()`。
- `searchSessionsByTitle()`。
- project path canonicalization。
- worktree fallback。

测试：

- pagination。
- sidechain filtering。
- metadata-only filtering。
- all projects listing。
- same repo / worktree listing。

### Phase 5：Restore Runtime State

实现：

- file history snapshots。
- attribution snapshots。
- content replacement records。
- todos from transcript。
- context collapse commit/snapshot restore。

这些依赖其他模块，进入 corresponding deferred gates。

### Phase 6：Sidechain / Remote / Activity

实现：

- subagent transcript path。
- agent metadata sidecar。
- remote agent metadata。
- remote hydration adapter interface。
- session activity heartbeat。

这些不阻塞主 agent core，但需要为 subagent/worktree/remote 规划接口。

## 9. Feature Matrix

| Feature | Current | Target | Status |
| --- | --- | --- | --- |
| JSONL append | yes | stable writer | `compare` skeleton |
| project chat path | yes | project storage | `compare` skeleton |
| accepted input before model | yes | durable ordering | `compare` |
| resume main messages | yes | replay state | `compare` skeleton |
| malformed line diagnostics | yes | rich diagnostics | `compare` partial |
| incomplete turn handling | yes | recoverable diagnostics | `compare` partial |
| parentUuid chain | yes | chain reader (`buildConversationChain`) | `compare` |
| parallel tool result recovery | partial (orphan append) | chain recovery | `compare` partial — orphans appended at chain tail |
| compact boundary | yes | `findLastCompactBoundaryIndex` + replay slicing | `compare` |
| metadata title/tag | yes | metadata store + tail re-append + resume restore | `compare` |
| session list/search | yes | `listProjectSessions` + `listAllSessions` + `searchSessionsByTitle` | `compare` |
| sidechain/subagent transcript | no | sidechain store | `deferred` |
| remote hydration | no | remote adapter | `not_applicable` first phase |
| activity keepalive | no | remote activity | `deferred` |
| file history / attribution | no | restore runtime state | `deferred` |

## 10. Intentional Differences

| ID | Legacy behavior | PolitDeck behavior | Reason | Risk |
| --- | --- | --- | --- | --- |
| `session-politdeck-paths` | Legacy uses `~/.claude/projects/<sanitized-path>/<session>.jsonl` | PolitDeck uses `~/.politdeck/projects/<projectId>/chats/<session>.jsonl` | Product namespace and clearer chat subdirectory | same |
| `session-canonical-message` | Legacy transcript stores legacy `Message` variants | PolitDeck stores `CanonicalMessage`-based entries | Provider-neutral architecture | same |
| `session-no-progress-chain` | Legacy has legacy progress bridge for old transcripts | PolitDeck first format excludes progress from durable chain | Avoid known chain fork bug from old implementation | lower |
| `session-remote-adapter-boundary` | Legacy remote/CCR hydration is inside sessionStorage | PolitDeck should put remote transport behind adapter interface | Keep core session portable | lower |

## 11. Deferred Register

| ID | Behavior | Phase | Release gate |
| --- | --- | --- | --- |
| `session-parent-chain` | UUID parent chain and leaf selection | Phase 2 | ✅ resolved — `TranscriptChain.ts` `buildConversationChain()` |
| `session-parallel-tool-recovery` | Recover orphaned parallel tool results | Phase 2 | ✅ resolved (partial) — orphans appended to chain tail |
| `session-compact-boundary` | Compact boundary aware replay | Phase 2 | ✅ resolved — Phase 1.5 `control_boundary` + `findLastCompactBoundaryIndex` |
| `session-metadata-store` | title/tag/PR/mode/worktree metadata | Phase 3 | ✅ resolved — `SessionMetadataStore` + `restoreFromReplay` + `reappendTail` |
| `session-listing` | list/search sessions with pagination | Phase 4 | ✅ resolved — `listProjectSessions` + `listAllSessions` + `searchSessionsByTitle` |
| `session-lite-reader` | head/tail bounded reader | Phase 4 | ✅ resolved (existed) — `readSessionLite()` 64KB head/tail |
| `session-worktree-lookup` | same repo/worktree session lookup | Phase 4 | worktree release |
| `session-file-history-restore` | file history snapshots | Phase 5 | edit history UI |
| `session-attribution-restore` | attribution snapshots | Phase 5 | attribution feature |
| `session-content-replacement` | tool result budget replacement state | Phase 5 | context budget release |
| `session-sidechain` | subagent transcript and sidecar metadata | Phase 6 | subagent release |
| `session-remote-hydration` | remote/CCR event hydration | Remote adapter phase | remote release |
| `session-activity` | keepalive heartbeat | Remote adapter phase | remote release |

## 12. Test Plan

### Unit tests

当前已有：

- `tests/agent/transcript-jsonl.test.ts`
- `tests/agent/resume.test.ts`

后续新增：

```text
tests/session/transcript-writer.test.ts
tests/session/transcript-reader.test.ts
tests/session/transcript-chain.test.ts
tests/session/resume.test.ts
tests/session/list-sessions.test.ts
tests/session/metadata.test.ts
tests/session/project-storage.test.ts
```

### Dual parity fixtures

建议新增：

```text
tests/fixtures/session/dual-parity/
  contractScenarios.ts
  executionScenarios.ts

third-party/claude-code-main/src/
  politdeck-session-legacy-contract-report.ts
  politdeck-session-legacy-execution-report.ts

tests/session/
  parity-dual-contract.test.ts
  parity-dual-execution.test.ts
```

第一批 compare scenarios：

- accepted input appears before assistant output。
- durable assistant + tool_result replay。
- malformed line diagnostic。
- project path derivation。
- custom title metadata precedence（实现后）。
- list sessions pagination（实现后）。

Deferred scenarios 必须有 reason，不允许跳过。

## 13. Validation Commands

常规：

```bash
npm run build
npm test
```

Legacy probe：

```bash
bun run src/politdeck-session-legacy-contract-report.ts
bun run src/politdeck-session-legacy-execution-report.ts
```

避免直接编译整个 vendored tree。sessionStorage.ts 依赖面很大，legacy probe 应聚焦可导入的 pure/portable 函数，或使用 fixture 文件直接跑 CLI-style probes。

## 14. Release Gates

主 session core 可认为完成的最低条件：

- JSONL writer/reader 支持 stable schema。
- accepted input 必须先写。
- resume 能重建主 session messages。
- malformed / partial transcript 有 diagnostics。
- parent chain 和 parallel tool result recovery 完成。
- compact boundary aware replay 完成。
- list sessions 支持 project scope 和 pagination。
- metadata title/tag restore 完成。
- `npm test` 通过。
- dual parity harness 存在，所有非 compare scenario 有 reason。

不得声称完成的情况：

- 只有 in-memory transcript。
- 只按 sequence replay，不处理 parent chain，却声称 legacy resume parity。
- 没有 head-tail reader，却声称支持 large transcript listing。
- metadata 不 re-append，却声称 list/resume title parity。
- sidechain/subagent transcript 未实现，却声称 subagent session parity。

# PolitDeck 延期 Feature 后续实现开发文档

本文用于把当前所有"骨架 / open / deferred / blocked"feature **拆成可直接动手的独立 PR**。每条 feature 都给出：

1. **是啥**（大白话定义）
2. **legacy 参考**（`third-party/claude-code-main` 具体路径 + 关键 export + 必须保留的行为编号表）
3. **当前 PolitDeck 骨架**（如果有，路径 + 缺什么）
4. **设计决策**（接口、命名、依赖边界）
5. **实现步骤**（编号步骤，每步一组文件 + 关键代码骨架）
6. **行为对齐 checklist**（与 legacy 完全保留的行为列表，PR 必须 100% 勾完或显式标 `intentional_difference`）
7. **测试范围**（unit / dual-parity / e2e）
8. **工作量 + 风险**
9. **输出**（新增/改动文件 + 文档同步项）

本文遵循 `.cursor/skills/refactor-with-parity` 要求：所有"行为一致"的声明都要伴随同一组 scenario 同时跑 PolitDeck 和 legacy 并比较归一化输出。任何不可对齐项都必须显式标注 `intentional_difference` 并写理由。

> **2026-05-09 实现细节强化**：每条 Tier A/B/C feature 的 §X.X.6 加了"行为对齐 checklist"——把 legacy 文件里逐行抽出来的关键行为编号成 checklist 项，例如 W1..W13（web_fetch 13 项安全行为）、S1..S12（subagent 12 项 fork 行为）、F1..F14（file-history 14 项行为）、M1..M16（MCP 16 项行为）、T1..T11（background task 11 项）。开发时按 checklist 实装、PR 描述里勾选每条，未对齐者必须显式标注。

> **2026-05-09 cron PR 协调对齐**：与同事 cron PR owner 确认所有命名空间 / hook 顺序 / process model / config 节点边界（详见 §1.3.1 / §2.3.1 / §6.5 SessionRouter hook 顺序 / §8.2.1）。本文 13 项 feature 与 cron PR **可完全并行 PR**，无相互 block。具体边界：
>
> - Gateway 协议：`elicitation_*`（B1）/ `task_*`（C5）/ `cron_*`（cron owner）三套命名空间互不重叠
> - SessionRouter hook priority：`[100,199]` cron / `[200,299]` 本文 C5；cron 先 schedule_next_trigger 再走 C5 task cleanup
> - CLI：`politdeck rewind`（本文 C4）vs `politdeck cron *`（cron owner）独立
> - PolitConfig：`cron?` 顶层节由 cron owner 创建；本文不动顶层结构
> - Tool registry：本文 `task_*` / `web_fetch` / `ask_user_question` / `mcp__*` / `agent` 与 cron 的 `cron_*` 互不冲突
> - Process model：本文 C5 = session-process scope；cron = daemon-process scope；第一版独立 store，未来跨进程 tracker 走 RFC

---

## 1. 范围与目标

### 1.1 覆盖项

按照前一轮代码扫描，本文覆盖以下 18 项延期 feature（A 类 5 项 + B 类 3 项 + C 类 5 项 + D 类 5 项）。每项都映射到 `tool` / `context` / `session` / `agent` / `adapter` / `gateway` 中的某个 owner，并给出建议落地顺序。

**本轮实施范围（2026-05-09 决策）**：A + B + C 全部 13 项，wave-by-wave 串行，无硬 deadline。**D 类 5 项暂不实施**——等远端连接 / 企业 SaaS / 部署形态等产品方向决策后另开 RFC。本文 §7 仍保留 D 类设计内容作为参考。

| Tier | 工时量级 | 含义 |
| --- | --- | --- |
| A | 几小时 ~ 半天 | 单 PR、纯本仓代码、不引新依赖、不动公共协议 |
| B | 半天 ~ 1 天 | 单 PR、可能引一个 npm 包或一个 model 协议字段 |
| C | 1 ~ 2 天 | 新增一整个子模块/runtime；建议**单独 PR**，可能跨 owner 评审 |
| D | 决策类（代码量大小不一） | 工作量取决于产品方向；先开 RFC 决策后再实现 |

### 1.2 明确不在本文范围

以下项已经由其他 owner / 文档单独跟进，本文只引用、不重复设计：

- `cron_*` 工具 + scheduler + Gateway cron 协议 → 同事 owner，见 `politdeck-tool-refactor-development-guide.md` §14.1。
- `agent` 工具 P0（同步单次模型调用）/ `read_file` 多模态 / `memory_*` / `edit_file` multi-edit / `skill` / `web_search` / `ConcurrentToolScheduler` / `skill_manage` / `config` / `notebook_edit` / `todo_write` → 见 `politdeck-tool-refactor-development-guide.md` §1.6.2，正在/已完成。
- context Phase 1.5–6 的全部 sub-engine（PromptAssembler / Compaction / Memory / Attachment / Recovery / Extension）→ 见 `politdeck-context-refactor-development-guide.md`，已完成。
- session compact-boundary / parent-chain / metadata-tail / list-all → 见 `politdeck-session-refactor-development-guide.md`，已完成。

### 1.3 命名/边界规则（适用全文）

- 新代码一律使用 `PolitDeck` / `politdeck` 命名；旧 brand 名（Claude / claude / tengu）只允许在文档和 legacy probe 路径中出现。
- 事件名按 `politdeck_<module>_<verb>` 命名，例如 `politdeck_subagent_started` / `politdeck_mcp_connected`。
- 错误码按 `<module>_<reason>` 命名，例如 `subagent_recursion_limit` / `mcp_handshake_failed` / `bg_task_not_found`。
- 不允许把 legacy `Tool` / `Message` / `AppState` 等 type alias 直接当作 PolitDeck 公共协议导出。
- 任何"behavior parity"声明必须有 `tests/fixtures/<module>/dual-parity` 同步 fixture 支撑。

#### 1.3.1 多 owner 共存的命名空间约定（2026-05-09 与 cron owner 对齐）

为避免与同事正在做的 cron PR 冲突，本文 feature 使用如下 **前缀命名空间**，互不重叠：

| 前缀 | Owner | 包含 feature |
| --- | --- | --- |
| `cron_*` | cron PR owner（同事） | `cron_create` / `cron_list` / `cron_delete` / `cron_stop`（工具 + Gateway 方法 + CLI 子命令均使用此前缀） |
| `elicitation_*` | 本文 B1 | `elicitation_request` / `elicitation_answer`（Gateway 双向消息） |
| `task_*` | 本文 C5 | `task_create` / `task_list` / `task_output` / `task_stop`（工具 + Gateway 状态推送） |
| `subagent_*` | 本文 C2 + C3 | `subagent_started` / `subagent_completed` / `subagent_recursion_limit`（transcript entry + 错误码） |
| `mcp_*` | 本文 C1 | `mcp_handshake_failed` / `mcp_session_expired` / `mcp_call_timeout` / wireName `mcp__<server>__<tool>`（错误码 + 工具命名） |
| `file_history_*` | 本文 C4 | `file_snapshot_recorded`（transcript entry）+ CLI `politdeck rewind` |

**冲突保证**：
- `cron_*` 永远不被本文 13 项 feature 占用。
- 本文 13 项 feature 永远不创建 `cron_*` 命名的 tool / Gateway 方法 / CLI 命令 / 错误码 / transcript entry。
- 任何跨命名空间的"共享"基础设施（例如未来把 cron + C5 抽成共享 task tracker）必须通过显式 RFC 决策，且接口位于中立模块（如 `src/task/protocol/`），不放任一前缀子目录下。

---

## 2. Source Of Truth

### 2.1 legacy 参考路径

| Feature | legacy 实现 | 关键 export |
| --- | --- | --- |
| Subagent 完整 fork | `third-party/claude-code-main/src/tools/AgentTool/forkSubagent.ts` (211 行) | `isForkSubagentEnabled` / `FORK_AGENT` / `isInForkChild` / `buildForkChildMessages`（参考实现，PolitDeck 必须改写） |
| Subagent runtime | `third-party/claude-code-main/src/tools/AgentTool/runAgent.ts` (973 行) | `runAgent` async generator 把 `availableTools` / `toolUseContext` / `agentDefinition` 编排成一次完整 query |
| Subagent transcript | `third-party/claude-code-main/src/tools/AgentTool/{resumeAgent.ts,agentMemorySnapshot.ts}` | sidechain transcript 写盘 + resume |
| Web fetch full | `third-party/claude-code-main/src/tools/WebFetchTool/{WebFetchTool.ts,utils.ts,prompt.ts,preapproved.ts}` | `getURLMarkdownContent` / `applyPromptToMarkdown` / `getTurndownService` / `LRUCache` 缓存 |
| MCP 真实 runtime | `third-party/claude-code-main/src/services/mcp/client.ts` (3353 行) + `MCPConnectionManager.tsx` + `auth.ts` | `Client` from `@modelcontextprotocol/sdk` + `StdioClientTransport` / `SSEClientTransport` / `StreamableHTTPClientTransport` / `WebSocketTransport` |
| MCP elicitation | `third-party/claude-code-main/src/services/mcp/elicitationHandler.ts` | `runElicitationHooks` / `ElicitationWaitingState` |
| ask_user_question UI | `third-party/claude-code-main/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` | 走 Ink + Tool input schema + `MessageResponse` |
| Background task | `third-party/claude-code-main/src/tasks/{types.ts,LocalShellTask/,LocalAgentTask/,InProcessTeammateTask/}` | `BackgroundTaskState` 联合类型 + `isBackgroundTask` + `isBackgrounded` 标记 |
| Cached microcompact | `third-party/claude-code-main/src/services/compact/microCompact.ts` (lines 56–80 起的 `CachedMCState` 框架，cachedMicrocompact.ts 在当前子树未收录) | feature-gated import + `notifyCacheDeletion` |
| Real tokenizer | `third-party/claude-code-main/src/services/tokenEstimation.ts` (lines 124, 140) | `countTokensWithAPI` / `countMessagesTokensWithAPI` / `bytesPerTokenForFileType` |
| Snip compact | `third-party/claude-code-main/src/QueryEngine.ts` 提到 `SnipTool`（当前子树无完整实现，仅 reference） | parity 时仅做 token 等价 + boundary marker，不复刻 SnipTool UI |
| File history | `third-party/claude-code-main/src/utils/fileHistory.ts` (1115 行) + `attribution.ts` (393 行) | `fileHistoryTrackEdit` / `fileHistoryMakeSnapshot` / `fileHistoryRewind` / `copyFileHistoryForResume` |
| Worktree lookup | `third-party/claude-code-main/src/utils/worktree.ts` (1519 行) | `findCanonicalGitRoot` / `getCommonDir` / `parseGitConfigValue` 已经够用，本文只用最小子集 |
| Activity / remote | `third-party/claude-code-main/src/utils/activityManager.ts` + `utils/background/remote/remoteSession.ts` | heartbeat + lease |

### 2.2 当前 PolitDeck 骨架

| 文件 | 现状 | 缺口 |
| --- | --- | --- |
| `src/tool/builtin/agent.ts` | ✅ P0 单次模型调用 | 没有递归子 loop / 子工具池 / sidechain transcript |
| `src/tool/builtin/webFetch.ts` | ⚠️ 始终返回 `unsupported_tool` | 缺 fetch + HTML→Markdown + secondary model 调用 |
| `src/tool/builtin/askUserQuestion.ts` | ⚠️ 始终返回 `unsupported_tool` | 缺 adapter 端 elicitation 协议 |
| `src/tool/builtin/structuredOutput.ts` | ⚠️ 直接返回输入（无 schema 校验） | 缺 model 协议 `outputSchema` 字段 + provider 翻译 |
| `src/tool/builtin/mcpTool.ts` | ⚠️ 仅有 `createMcpTool` 包装器 + adapter 接口 | 缺真实 `Client` / transport / connect / handshake |
| `src/extension/plugins/runtime/PluginRuntime.ts` | ✅ `mcpServers()` 只读聚合 | 缺真实连接客户端 + instructions delta + tool list 同步 |
| `src/session/storage/` | ✅ 单仓库 listing / search | 缺 worktree lookup / file history / sidechain |
| `src/context/budget/TokenBudgetManager.ts` | ✅ char/4 估算 | 缺真实 tokenizer fallback |
| `src/context/compaction/MicroCompactionEngine.ts` | ✅ time-based | 缺 cached / Anthropic prompt-cache 路径 |
| `src/adapters/channel/feishu/` | ✅ 基本走通 | 缺 OAuth / TLS / multi-device / rate limit |
| `src/gateway/server/` | ✅ localhost-only | 缺 TLS / 远端 lease / activity heartbeat |

### 2.3 模块边界与接入点

```text
agent
├── loop/AgentLoop.ts         （消费 ContextRuntime + ToolScheduler，不能反向依赖具体 tool）
├── sub/                       （subagent fork，§6.2 C2 新子模块）
context
├── compaction/                （tokenizer fallback、cached MC、snip 都在这里加）
├── budget/TokenBudgetManager  （tokenizer 接入点）
tool
├── builtin/                   （webFetch / mcpTool / askUserQuestion / structuredOutput / task_* 都在这里完善）
├── execution/ToolRuntime      （tool 内调 model / 后台任务句柄注入）
task                           （新模块，§6.5 C5 引入）
├── protocol/                  （PolitDeck task state types — session-scope）
├── runtime/BackgroundTaskRuntime
└── storage/TaskOutputStore
mcp                            （新模块，§6.1 C1 引入）
├── client/                    （Client + transports）
├── runtime/                   （MCPRuntime：connect / list / call / instructions）
session
├── filesystem/                （file-history / attribution，§6.4 C4 新子模块）
├── worktree/                  （worktree lookup，§4.1 A1 新子模块）
├── transcript/                （subagent sidechain，§6.3 C3 升级）
adapters
├── elicitation/               （ask_user_question 通道，§5.1 B1 新子模块）
gateway
├── protocol/                  （elicitation_* 双向消息，§5.1 B1）
├── activity/                  （remote heartbeat，D1 决策后）
```

每个新模块都必须定义稳定接口，让 agent / tool 通过依赖注入消费，不能让 `AgentLoop` / `ToolRuntime` 直接 `import` 具体 transport / RPC 客户端。

#### 2.3.1 cron PR 接入点（同事 owner，本文不实施，仅协调）

cron 同事确认会用如下接入点，**与本文 13 项 feature 完全解耦**——下面列出来只是为了 PR 作者知道哪些代码不要碰：

```text
（cron 同事 owner，本文不修改）
src/cron/                      （新模块，daemon-scope，跨 session 生命周期）
├── protocol/                  （CronJob / CronRun / cron_* Gateway 方法）
├── runtime/                   （scheduler，运行在 daemon process，不在 session process）
├── storage/                   （独立 cron job/run store，不复用 task store）
src/cli/commands/cron/         （politdeck cron create/list/delete/stop）
src/tool/builtin/cron*.ts      （cron_* 工具：cron_create / cron_list / cron_delete / cron_stop）
src/gateway/protocol/types.ts  （加 cron_* 方法到 Gateway interface — 不动 elicitation_* / task_* 部分）

PolitConfig:
politdeck.yaml
└── cron?: CronConfig          （顶层 config 节点，本文 feature 不读不写）
    ├── enabled: boolean
    ├── timezone?: string
    ├── storageDir?: string
    ├── defaultMode?: ...
    └── concurrency?: ...      （schedule expression 是任务数据，不在此 config）
```

**Cron 与 C5（background task）的边界 + process model 区别**：

| 维度 | C5 BackgroundTaskRuntime（本文 §6.5） | Cron（同事，daemon） |
| --- | --- | --- |
| Scope | session-scope | daemon-scope（跨 session 生命周期） |
| 进程位置 | session 主进程内 runtime | daemon / server 进程内 scheduler |
| 生命周期触发 | session 内一次性后台任务 | 周期性 schedule（cron expression） |
| Session 结束 | runtime 自动 SIGTERM 全部未结束 task | scheduler 不受影响，下次 trigger 仍正常调度 |
| 一次 cron run 触发后 | — | 通过 gateway `submitTurn` 绑定原 sessionKey/channelKey/projectKey 复用现有会话路径 |
| 第一版 store | 独立 `~/.politdeck/projects/<id>/sessions/<sid>/tasks/` | 独立 `~/.politdeck/cron/`（cron 同事 owner） |
| 共享 task tracker | **第一版不共享**（双方独立 store + protocol） | — |
| 后续合并 | 如果 D 类 remote / multi-process tracker 真要做，再开 RFC 抽中立 `src/task/protocol/` 接口 | — |

---

## 3. 实现优先级总表

按落地顺序排（数字小 = 早做）。"依赖" 列表示该项需要先完成的前置 item id。

| ID | Feature | Tier | Owner 建议 | 依赖 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| A1 | session worktree lookup | A | session | — | 3 h |
| A2 | real tokenizer fallback | A | context | — | 3 h |
| A3 | structured_output 简化版（model 协议加 `outputSchema`） | A | model + tool | — | 3 h |
| A4 | cached microcompact (Anthropic-only) | A | context | A2 可选 | 半天 |
| A5 | snip compact 策略 | A | context | A2 | 半天 |
| B1 | adapter elicitation 协议 + ask_user_question 通道 | B | adapter + tool | — | 半天 |
| B2 | web_fetch 完整版（HTML→MD + 工具内调 model） | B | tool | T1 一部分 | 1 天 |
| B3 | MCP instructions 注入 | B | context + tool | C2 partial（只读 instructions） | 半天 |
| C1 | MCP runtime（connect / list / call） | C | mcp（新模块） | — | 1.5 天 |
| C2 | subagent-fork-full（递归子 loop） | C | agent + tool | T1 | 1.5 天 |
| C3 | session sidechain transcript | C | session | C2 | 半天（依赖 C2） |
| C4 | session file-history / attribution | C | session | — | 1.5 天 |
| C5 | background task runtime（local shell + agent） | C | tool + adapter | — | 1.5 天 |
| D1 | session remote / activity heartbeat | D | gateway | 远端方向决策 | 半天（决策后） |
| D2 | Feishu OAuth | D | adapter | 产品决策 | 1 天（决策后） |
| D3 | Gateway TLS | D | gateway | 部署决策 | 半天（决策后） |
| D4 | Feishu multi-device | D | adapter | 产品决策 | 1 天（决策后） |
| D5 | Gateway rate limit | D | gateway | 部署决策 | 半天（决策后） |
| T1 | tool 协议添加 `model` 客户端 + onProgress（已完成） | — | tool | — | done ✅ |

---

## 4. Tier A — 单 PR 几小时级

每条都满足：纯本仓代码、不引新 npm 依赖、不动公共协议、不跨 owner。

### 4.1 A1 — Session worktree lookup

#### 4.1.1 是啥（大白话）

`repo/main` 和 `repo/feature` 是同一个 git 仓库的两个 worktree。想让两边的 session **算同一个 project**，列表 / 搜索 / `~/.politdeck/projects/<id>/` 目录都共享。

#### 4.1.2 legacy 参考（必须对齐的行为）

| legacy 路径 | 行为 |
| --- | --- |
| `third-party/claude-code-main/src/utils/git.ts` line 27-86 `findGitRootImpl` | 从 cwd **同步** 向上 walk，找 `.git`（dir 或 file），返回 NFC normalize 的 root；失败返回 sentinel；LRU 50 entries memoize |
| `git.ts` line 123-183 `resolveCanonicalRoot` | 把 worktree root 解析到 main repo root：读 `.git` 文件 → 解 `gitdir:` → 读 `commondir` → 验证 path layout + back-link → realpath compare |
| `git.ts` line 195-210 `findCanonicalGitRoot` | 入口：先 `findGitRoot` 后 `resolveCanonicalRoot` |
| `git/gitFilesystem.ts` line 273-280 `getCommonDir` | 读 `<gitDir>/commondir`，resolve 相对路径 |
| 安全验证（line 142-170） | (1) `dirname(worktreeGitDir) === <commonDir>/worktrees`；(2) `realpath(<worktreeGitDir>/gitdir)` 必须等于 `realpath(gitRoot)/.git`；(3) 普通 .git 目录直接返回 |

**legacy 的 6 个关键安全 / 性能行为**：
1. **Sync 文件系统**（不走 git subprocess）—— 子进程 spawn 15ms 太慢，`statSync` ~0.5ms。
2. **NFC normalize**：macOS 文件名归一化，`café` 多种 byte 序列要折叠。
3. **LRU memoize 50 entries**：避免 dirname-iterate 重复读盘。
4. **读取 `.git` 文件 vs 目录**：worktree 的 .git 是 file，submodule 也是 file（但 submodule 没 commondir → fall through）。
5. **Path layout 校验**：防止恶意 repo 把 commondir 指向受害者的可信目录。
6. **Realpath 比较**：legacy / 真实文件系统经常涉及 `/tmp → /private/tmp` 这种 symlink。

#### 4.1.3 当前 PolitDeck 骨架

- `src/session/storage/createProjectId.ts`：当前直接 hash `cwd`，无 git awareness。
- `src/session/storage/SessionList.ts`：`listAllSessions` / `searchSessionsByTitle` 已异步扫 `~/.politdeck/projects/<id>/`。

#### 4.1.4 设计决策

PolitDeck 选 **filesystem-only async**（不走 git subprocess），尽可能对齐 legacy 行为。理由：subprocess 慢且 PATH/auth 风险大；legacy filesystem 路径已经经过验证。

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| API 同步 vs 异步 | **async**（PolitDeck 既有 IO 都 async） | 与现有 `createProjectId` 调用方匹配；不阻塞 event loop |
| 安全验证 | **完整对齐 legacy**（layout + back-link + realpath） | 防止"恶意 repo 借用别人 project ID"漏洞 |
| Memoize | **LRU 50 entries**，与 legacy 同 | 避免重复读盘 |
| Submodule 行为 | fall-through 到 `findGitRoot` 结果（与 legacy 一致） | submodule 是独立 repo，不应 share project ID |
| Bare-repo worktree | 用 `commonDir` 本身做 identity（line 173-176） | 与 legacy 完全一致 |
| NFC normalize | **必做**（`.normalize('NFC')`） | macOS 文件名兼容 |
| 失败 fallback | 返回 cwd（与 legacy `findGitRoot` 失败时返回 null 不同——PolitDeck 永远要有 project ID） | PolitDeck 不允许"无 project" 状态 |

**API**：

```ts
// src/session/worktree/findCanonicalProjectRoot.ts
export async function findCanonicalProjectRoot(cwd: string): Promise<string>;
```

返回字符串：成功 → canonical root；失败 → `path.resolve(cwd)`。**永不抛异常**。

#### 4.1.5 实现步骤

1. **`src/session/worktree/findGitRoot.ts`**（对应 legacy `git.ts` line 27-86）：
   - 从 `path.resolve(cwd)` 起向上 walk
   - 每层 `await fs.stat(join(current, '.git'))`，dir 或 file 都算命中
   - 命中 → `current.normalize('NFC')` 返回
   - 未命中 → null
   - LRU 50 entries memoize（自己写一个 `class LRUMap<K, V>`，~30 行；不引依赖）

2. **`src/session/worktree/resolveCanonicalRoot.ts`**（对应 legacy line 123-183）：
   - 读 `<gitRoot>/.git`：`fs.readFile(..., 'utf-8')`
   - 失败（EISDIR）→ 普通 repo，直接返回 `gitRoot`
   - 解 `gitdir: <path>` → `worktreeGitDir = path.resolve(gitRoot, parsed)`
   - 读 `<worktreeGitDir>/commondir` → `commonDir = path.resolve(worktreeGitDir, parsed)`（失败 → submodule，返回 `gitRoot`）
   - **安全验证 #1**（layout）：`path.resolve(path.dirname(worktreeGitDir)) !== path.join(commonDir, 'worktrees')` → 返回 `gitRoot`
   - **安全验证 #2**（back-link）：读 `<worktreeGitDir>/gitdir` → `await fs.realpath(content)` → 必须等于 `await fs.realpath(gitRoot)` 拼 `.git`
   - 普通 `.git` 目录在 commonDir：`path.basename(commonDir) === '.git'` → `path.dirname(commonDir).normalize('NFC')`
   - Bare-repo worktree：`commonDir.normalize('NFC')`

3. **`src/session/worktree/findCanonicalProjectRoot.ts`**：组装 `findGitRoot` + `resolveCanonicalRoot`，失败 → `path.resolve(cwd)`。LRU 50 entries（共享）。

4. **改 `src/session/storage/createProjectId.ts`**：
   - 加 `createProjectIdAsync(cwd)`（new export）：内部 `await findCanonicalProjectRoot(cwd)` 后 hash。
   - 保留同步 `createProjectId(cwd)`（hash cwd 直接）作 legacy fallback / 测试 fixture 用，**标 `@deprecated`**。
   - 所有现有调用迁移到 `createProjectIdAsync`。

5. **`src/session/storage/SessionList.ts`**：`listProjectSessions(cwd, ...)` 内部用 `createProjectIdAsync(cwd)`。`listAllSessions(politHome)` 不变。

6. **新增 `src/session/storage/SessionList.findByProjectRoot(root)`**：直接给 canonical root 查 sessions（worktree-aware UI 用）。

#### 4.1.6 行为对齐 checklist

实现后必须验证：

- [ ] 同一个仓库的 main + worktree 解析到**同一个 canonical root**
- [ ] 普通 git repo 解析回**自身 root**
- [ ] Submodule 解析回**自身 root**（不被父 repo 借用）
- [ ] 非 git 目录返回 cwd
- [ ] 恶意 commondir（指向系统目录）被验证拒绝 → 返回 worktree 自身
- [ ] 恶意 gitdir back-link 被验证拒绝 → 返回 worktree 自身
- [ ] macOS 上 `/tmp` ↔ `/private/tmp` symlink 的 worktree 不被误判
- [ ] NFC 字符归一化（`café` 两种 byte sequence 同 ID）
- [ ] LRU 命中（同 cwd 第二次调用 < 1ms）
- [ ] git 命令不可用也能跑（不依赖 git subprocess）

#### 4.1.7 测试

```text
tests/session/worktree/
  findGitRoot.test.ts          : .git dir / .git file / 找不到 / NFC
  resolveCanonicalRoot.test.ts : 普通 repo / worktree / submodule / 恶意 layout / 恶意 back-link / bare-repo
  findCanonicalProjectRoot.test.ts : 端到端 + LRU 命中 + cwd fallback
  parity.test.ts                : 与 legacy `findCanonicalGitRoot` 同样输入返回相同结果（dual_parity）
```

**Dual-parity scenarios**（`tests/fixtures/session/dual-parity/worktree-canonical-root.scenarios.ts`）：

```ts
[
  { name: "regular_repo", cwd: <fixture>, parityStatus: "dual_parity" },
  { name: "worktree_main_to_canonical", cwd: <worktree path>, parityStatus: "dual_parity" },
  { name: "submodule_isolation", parityStatus: "dual_parity" },
  { name: "non_git_directory", parityStatus: "intentional_difference",
    note: "legacy 返回 null，PolitDeck 返回 cwd（永不无 project ID）" },
  { name: "malicious_commondir", parityStatus: "dual_parity" },
  { name: "macos_tmp_symlink", parityStatus: "dual_parity" },
]
```

**fixture 制造**：用 `tests/helpers/gitFixture.ts` 临时目录跑 `git init` + `git worktree add` 真实创建。CI 必须有 git 可用。

#### 4.1.8 工时与风险

- 实现：3-4 小时
- 测试 + dual-parity fixture：2 小时
- 风险：fs.realpath 在 Windows 行为差异（macOS / Linux 优先；Windows 走 fallback）

#### 4.1.9 输出

- 5 个新文件：`findGitRoot.ts` / `resolveCanonicalRoot.ts` / `findCanonicalProjectRoot.ts` / `LRUMap.ts` / 测试
- 修改：`createProjectId.ts` / `SessionList.ts`
- 文档同步：`politdeck-session-refactor-development-guide.md` §11 `session-worktree-lookup` → resolved

---

### 4.2 A2 — Real tokenizer fallback

#### 4.2.1 是啥（大白话）

`TokenBudgetManager.estimate(text) = text.length / 4` 对 dense JSON / tool result 显著低估，导致 auto-compact 触发太晚 → context overflow。**legacy 有一套精细的 per-block-type 估算**，特别是 image / PDF 用固定 2000 tokens（不是 base64 长度 / 4）。

#### 4.2.2 legacy 参考（13 个具体行为点）

`third-party/claude-code-main/src/services/tokenEstimation.ts` 5 个函数 + `compact/microCompact.ts` 1 个：

| legacy export | 行 | 行为 |
| --- | --- | --- |
| `roughTokenCountEstimation(content, bytesPerToken=4)` | 203 | `Math.round(content.length / bytesPerToken)`（**round**, 不是 ceil） |
| `bytesPerTokenForFileType(ext)` | 215 | `json/jsonl/jsonc → 2`；其他 → 4 |
| `roughTokenCountEstimationForFileType(content, ext)` | 234 | 上面两个的组合 |
| `roughTokenCountEstimationForMessages(messages)` | 327 | 遍历 + sum |
| `roughTokenCountEstimationForMessage` | 341 | type 分发：'assistant' / 'user' → content；'attachment' → normalize 后 content |
| `roughTokenCountEstimationForContent` | 371 | string 直接估；array 遍历 block |
| `roughTokenCountEstimationForBlock` | 391 | **每种 block 不同**（见下） |
| `microCompact.ts` `estimateMessageTokens` | 164-205 | **包含 4/3 padding**！`Math.ceil(totalTokens * 4 / 3)` |
| `microCompact.ts` `calculateToolResultTokens` | 138-157 | tool_result 内部 image/document = 2000 tokens |

**`roughTokenCountEstimationForBlock` 每种 block 行为**（关键！）：

| block.type | 估算 |
| --- | --- |
| `string`（裸字符串） | `roughTokenCountEstimation(block)` |
| `text` | `roughTokenCountEstimation(block.text)` |
| **`image`** | **2000 tokens 固定**（不是 base64 长度 / 4） |
| **`document`**（PDF） | **2000 tokens 固定**（base64 PDF ~325k 字符会被严重高估） |
| `tool_result` | 递归 `forContent(block.content)` |
| `tool_use` | `roughTokenCountEstimation(block.name + jsonStringify(block.input ?? {}))` |
| `thinking` | `roughTokenCountEstimation(block.thinking)`（**不算 signature**） |
| `redacted_thinking` | `roughTokenCountEstimation(block.data)` |
| 其他（server_tool_use / web_search_tool_result） | `roughTokenCountEstimation(jsonStringify(block))` |

**`countTokensWithAPI` / `countMessagesTokensWithAPI`**（line 124, 140）：
- Anthropic `messages.countTokens` API；只有 Anthropic / Vertex / Bedrock 支持
- 检测 thinking blocks → enable thinking with `budget_tokens: 1024`
- 失败 → 返回 null（caller fallback）
- 包含 `usage.cache_creation_input_tokens + cache_read_input_tokens`（line 320-324）

#### 4.2.3 当前 PolitDeck 骨架

- `src/context/budget/TokenBudgetManager.ts` 单一 `estimate(text) → Math.ceil(text.length / 4)`。
- `CanonicalModelClient` 无 `countTokens` 方法。

#### 4.2.4 设计决策

| 决策 | 选择 |
| --- | --- |
| 公式：round vs ceil | **round**（对齐 legacy line 207 `Math.round`） |
| 4/3 padding | **保留**（与 legacy `estimateMessageTokens` 一致；防低估） |
| Image / PDF 估算 | **固定 2000 tokens**（**关键**） |
| `countTokensWithAPI` | **接接口但本轮不 enable**（Anthropic provider 后续 RFC） |
| API 调用频率 | 后续接入时：autoCompact 前最多每分钟 1 次 |
| 不引 tiktoken | yes（保持 zero-deps fallback） |

**API**（在 `TokenBudgetManager`）：

```ts
estimate(text: string, opts?: { bytesPerToken?: number }): number  // 单字符串
estimateForFileType(content: string, ext: string): number          // ext-aware
estimateForBlock(block: CanonicalBlock): number                    // 每种 block
estimateForMessage(message: CanonicalMessage): number              // 含 4/3 padding
estimateForMessages(messages: CanonicalMessage[]): number          // sum + 4/3 padding
```

#### 4.2.5 实现步骤

1. **`src/context/budget/bytesPerToken.ts`**：

   ```ts
   export function bytesPerTokenForExt(ext: string | undefined): number {
     const lower = (ext ?? "").toLowerCase().replace(/^\./, "");
     if (lower === "json" || lower === "jsonl" || lower === "jsonc") return 2;
     return 4;
   }
   export function bytesPerTokenForMime(mime: string | undefined): number {
     if (!mime) return 4;
     if (mime.includes("json")) return 2;
     return 4;
   }
   ```

2. **`src/context/budget/IMAGE_MAX_TOKEN_SIZE.ts`** = 2000（const，与 legacy 同）。

3. **`src/context/budget/estimateForBlock.ts`** 完全对齐 legacy 9 种 block 分支（含 image/document = 2000）。

4. **`src/context/budget/TokenBudgetManager.ts`**：
   - 把 `estimate(text)` 改成 `Math.round(text.length / bytesPerToken)`（之前是 ceil → 改 round 可能影响 boundary 测试，需要审核）
   - 新增 5 个方法。
   - `estimateForMessages` 末尾 `Math.ceil(total * 4 / 3)`（对齐 legacy）。

5. **`src/model/protocol/canonical.ts`**：扩展 `CanonicalModelClient` 接口加 `countTokens?(messages, tools): Promise<number | null>`（可选；不实装实现）。

6. **`src/context/compaction/AutoCompactionPolicy.ts`**：把 `estimate(...)` 替换为 `estimateForMessages(...)`。

7. **`tests/context/budget/`**：每种 block 一例；JSON ext 路径；4/3 padding 验证。

#### 4.2.6 行为对齐 checklist

- [ ] `estimate("")` = 0（empty content special case）
- [ ] `estimate(content)` 用 `Math.round`（不是 ceil）
- [ ] `bytesPerTokenForExt("json")` = 2
- [ ] `bytesPerTokenForExt("jsonl")` = 2
- [ ] `bytesPerTokenForExt("ts")` = 4
- [ ] image block = 2000 tokens
- [ ] document block = 2000 tokens
- [ ] tool_use block = `name + jsonStringify(input)` 字符长度估
- [ ] thinking block 只算 `thinking` 字段，**不算 signature**
- [ ] tool_result 递归内部内容
- [ ] `estimateForMessages` 末尾乘 4/3
- [ ] 大 PDF（1 MB base64 → ~1.33M chars）只算 2000 tokens 而非 ~325k
- [ ] dense JSON（10 KB）按 5000 tokens 估，不是 2500

#### 4.2.7 测试

```text
tests/context/budget/
  bytes-per-token.test.ts
  estimate-for-block.test.ts    : 9 种 block 类型
  estimate-for-message.test.ts  : 4/3 padding 验证
  edge-cases.test.ts            : empty / image / 1MB PDF / dense JSON
  parity.test.ts                : 同样输入对比 legacy `roughTokenCountEstimationForMessage` 输出（dual_parity）
```

#### 4.2.8 工时与风险

- 实现：3 小时
- 测试 + parity fixture：2 小时
- 风险：原 `estimate` ceil → round 改动可能让现有 `auto-compaction` 测试 boundary 微调；需要重跑全套 context 测试。

#### 4.2.9 输出

- 4 个新文件 + 1 改动 + parity scenarios
- 文档同步：`context-real-tokenizer` deferred → partial（API count 仍未启用）

---

### 4.3 A3 — Structured output schema-driven（简化版）

#### 4.3.1 是啥（大白话）

让 model 在最后一步必须按一个 JSON schema 输出（比如 `{ status: "ok"|"err", code: number }`），provider 层面强制——不靠 prompt 工程也不靠工具自校验。

#### 4.3.2 legacy 参考

legacy `structured_output` 工具是给 SDK consumer 当 "final answer" 钩子，**不强制 schema**，是工具内部 zod parse。具体行为：

- `src/tools/SyntheticOutputTool/`（synthetic 是 alias，不是同一个名字，但语义近）：tool 接 `value: unknown` + `schema?: JsonSchema`，内部 ajv 校验。
- 真正的 schema-driven 在 SDK consumer 用 `outputSchema` 配置，最终通过 tool_use forced + zod 校验实现（不走 provider response_format）。

**因此 PolitDeck A3 不"对齐"legacy**——legacy 没做 native structured output。我们做的是 **provider-native** 路径（OpenAI `response_format` / Anthropic forced `tool_use`），属于 `intentional_difference`。

#### 4.3.3 当前 PolitDeck 骨架

- `src/tool/builtin/structuredOutput.ts`：直接返回 `input.value`，无校验。
- `src/model/protocol/types.ts`：`CanonicalModelRequest` 无 `outputSchema` 字段。
- `src/model/protocol/errors.ts`：无 `unsupported_capability` 错误码。

#### 4.3.4 设计决策

| 决策 | 选择 |
| --- | --- |
| 协议位置 | `CanonicalModelRequest.outputSchema?: CanonicalOutputSchema` |
| OpenAI 路径 | `response_format: { type: "json_schema", json_schema: { name, strict, schema } }`（OpenRouter / Kimi 通过 OpenAI 兼容协议都支持） |
| Anthropic 路径 | 用 forced `tool_use`：自动注入一个 hidden tool `__output__` schema=outputSchema，`tool_choice: { type: "tool", name: "__output__" }`；assistant 必须用这个 tool 输出 |
| 校验失败 | provider 已经 reject（OpenAI strict mode）；PolitDeck 端**不二次 zod 校验**（避免重复） |
| `structured_output` 工具 | 保留（SDK consumer 仍用），但不再是 schema 强制路径 |
| 错误码 | 加 `unsupported_capability`（Anthropic 不支持 strict 模式时） |

**API**：

```ts
type CanonicalOutputSchema = {
  name: string;          // schema 标识，必须 [a-zA-Z0-9_]+
  description?: string;
  schema: JsonSchema;    // 标准 JSON Schema
  strict?: boolean;      // OpenAI strict mode (default true)
};
```

#### 4.3.5 实现步骤

1. **`src/model/protocol/canonical.ts`** 加 `CanonicalOutputSchema` type。
2. **`src/model/protocol/types.ts`** `CanonicalModelRequest.outputSchema?: CanonicalOutputSchema`。
3. **`src/model/protocol/errors.ts`** 加 `unsupported_capability` 错误码。
4. **`src/model/providers/openai/buildRequest.ts`**：

   ```ts
   if (request.outputSchema) {
     body.response_format = {
       type: "json_schema",
       json_schema: {
         name: request.outputSchema.name,
         description: request.outputSchema.description,
         strict: request.outputSchema.strict ?? true,
         schema: request.outputSchema.schema,
       },
     };
   }
   ```

5. **`src/model/providers/anthropic/buildRequest.ts`**：
   - 在 tools 列表注入 hidden `__output__` tool（name 加唯一前缀避免冲突）
   - `tool_choice: { type: "tool", name: "__output__" }`
   - `disable_parallel_tool_use: true`

6. **`src/model/providers/anthropic/streamHandler.ts`**：检测 `tool_use.name === "__output__"` 时把 `input` 抽出来当 final assistant text/json。
7. **`src/agent/loop/AgentLoop.ts`**：支持 `outputSchema` 透传（最终 turn 才注入，避免影响 tool-loop turn）。
8. 测试 + e2e。

#### 4.3.6 行为对齐 checklist

- [ ] OpenAI 路径：mock fetch body 含 `response_format.type === "json_schema"`
- [ ] OpenAI strict 默认 true
- [ ] Anthropic 路径：tools 列表注入 `__output__`；`tool_choice` 强制
- [ ] Anthropic：返回的 `__output__` tool_use input 抽成 `final.text` 或 `final.json`
- [ ] Schema 名包含非法字符 → 校验失败（throw `invalid_request`）
- [ ] 模型违反 schema → provider 返回 error → PolitDeck 透传 `provider_error`
- [ ] 同一 turn 既要 tools 又要 outputSchema：tools loop 走完后**只在最终 turn**注入 outputSchema
- [ ] outputSchema + tools 同时存在时，Anthropic 路径的 tools 注入与原 tools 不冲突

#### 4.3.7 测试

```text
tests/model/providers/openai/output-schema.test.ts
tests/model/providers/anthropic/output-schema.test.ts
tests/agent/output-schema-final-turn.test.ts
tests/model/e2e/real-output-schema.test.ts (POLITDECK_RUN_REAL_OUTPUT_SCHEMA_E2E=1)
```

#### 4.3.8 工时与风险

- 实现：4 小时（OpenAI 半小时 + Anthropic forced tool 路径 2 小时 + 测试 1.5 小时）
- 风险：Anthropic forced tool_use 路径与 PolitDeck 现有 thinking + parallel tool 流程互相影响 → e2e 验证

#### 4.3.9 输出

- model 协议加 1 type、1 字段、1 错误码
- 2 个 provider build/stream 改动
- 4 个测试文件
- `politdeck-tool-refactor-development-guide.md` §13.X structured_output 章节升级

---

### 4.4 A4 — Cached microcompact (Anthropic-only)

#### 4.4.1 是啥（大白话）

普通 microcompact 是"删除老 tool result 内容"。**cached microcompact 多做一步**：每次删内容时记一笔 `cache_edits` 元数据 + 在 message 间插 `cache_control: { type: "ephemeral" }` 断点；下次请求 Anthropic 复用 cached prefix，**不重发被删掉的 history**——直接省费用。

#### 4.4.2 legacy 参考（必须保留的行为接口）

`third-party/claude-code-main/src/services/compact/microCompact.ts`（当前 vendored 子树包含 line 1-530，**真正 cached MC 实现 `cachedMicrocompact.ts` 未收录**）：

| legacy export | 行 | 行为 |
| --- | --- | --- |
| `cachedMCModule`（lazy require） | 56-69 | feature-gated 动态 import，避免外部 build pull-in |
| `cachedMCState` | 57 | 单例 state；`createCachedMCState()` |
| `pendingCacheEdits` | 58-60 | 当前 turn 待发出去的 cache_edits（ConsumeOnce） |
| `consumePendingCacheEdits()` | 88-94 | 取出 pending（caller 必须 pin） |
| `getPinnedCacheEdits()` | 100-105 | 已 pin 的（每次请求都重发同位置） |
| `pinCacheEdits(userMessageIndex, block)` | 111-118 | 插入新 pinned edits，关联到具体 user message index |
| `markToolsSentToAPIState()` | 124-128 | 工具变更 ack（避免误标） |
| `resetMicrocompactState()` | 130-135 | 显式 clear |
| `PendingCacheEdits` type | 207-213 | `{ trigger, deletedToolIds, baselineCacheDeletedTokens }` |
| `MicrocompactResult` | 215-220 | `{ messages, compactionInfo?: { pendingCacheEdits? } }` |
| `collectCompactableToolIds(messages)` | 226-241 | 遍历 assistant messages 收 tool_use IDs in `COMPACTABLE_TOOLS` |
| `isMainThreadSource(querySource)` | 249-251 | 只允许 `repl_main_thread*`（forked agent 不许走 cached MC） |
| `microcompactMessages(messages, ctx, querySource)` | 253-? | 主入口；先 time-based fast path → cached MC |

**`COMPACTABLE_TOOLS` 集合**（line 41-50）：
```text
file_read, bash 系列, grep, glob, web_search, web_fetch, file_edit, file_write
```

**关键行为约束**：
1. 只在主线程（`querySource.startsWith('repl_main_thread')`）启用——子代理共享 cachedMCState 会误删别人的 tool result。
2. 时间触发器先跑（cache 已 cold 时 cached MC 没意义，直接 time-based clean）。
3. `baselineCacheDeletedTokens`：上次 API 返回的 sticky 累计值，用于算本次 delta（line 211-213）。
4. `cache_edits` block 必须 pin 到 user message 后插入，下次请求保留位置（缓存命中要求 byte-identical prefix）。

#### 4.4.3 当前 PolitDeck 骨架

- `src/context/compaction/MicroCompactionEngine.ts`：仅 time-based 路径。
- `src/model/providers/anthropic/buildRequest.ts`：当前不带任何 `cache_control` breakpoint。
- `src/context/compaction/CompactionEngine.ts` 已经 emit `pre-/post-compact` lifecycle hook。

#### 4.4.4 设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 是否实装完整 `cachedMicrocompact` | **简化版**：不做 LRU pinned edits 跟踪 | legacy 实现未在 vendored 子树，逆向风险高 |
| Pinned vs Pending | **只做 pending**（当前 turn 标记并立即用） | 简化版不跨 turn 维护 |
| 标记位置 | 在被删 tool_result block **之前**最近一条 user message 加 `cache_control: ephemeral` | 与 Anthropic prompt cache breakpoint 标准用法一致 |
| feature gate | `politdeck.context.cachedMicrocompactEnabled`（默认 false） | 行为新且改 prefix bytes，先 opt-in |
| 主线程限制 | 必做（与 legacy 一致）：fork subagent 不进 cached MC | 防全局 state 污染 |
| 时间-based 短路 | 必做：time-based 先跑且短路 | 与 legacy 一致 |
| Token usage 单调验证 | E2E 必做：连续 2 turn 同一模型，第 2 turn `input_tokens` 严格 ≤ 第 1 turn baseline + new content | 否则证明 cache 被打破 |

#### 4.4.5 实现步骤

1. **`src/context/compaction/COMPACTABLE_TOOLS.ts`**：常量 set，与 legacy line 41-50 完全相同的工具名集合。
2. **`src/context/compaction/cachedMicrocompactState.ts`**：

   ```ts
   export type CachedMicrocompactState = {
     pendingDeletedToolIds: string[];
     pendingMarkerUserMessageId: string | null;
     baselineCacheDeletedTokens: number;
   };
   export function createCachedMicrocompactState(): CachedMicrocompactState;
   export function resetCachedMicrocompactState(s: CachedMicrocompactState): void;
   ```

3. **改造 `MicroCompactionEngine`**：
   - 加 `cachedState?: CachedMicrocompactState`（构造注入）
   - `executeMicrocompact(messages, ctx)` 内：先 time-based；time-based 命中 → 直接返回；否则
     - 检查 `isMainThreadSource(ctx.querySource)`（不是主线程 → 跳过 cached path）
     - 收集 compactable tool IDs（用 COMPACTABLE_TOOLS）
     - 标记被删的 tool_result content；记到 `pendingDeletedToolIds`
     - 找最近 user message → `pendingMarkerUserMessageId = id`

4. **`src/model/providers/anthropic/buildRequest.ts`**：
   - 接 `cacheBreakpointMessageIds?: string[]`
   - 翻译时找到对应 messages 给最后一个 content block 加 `cache_control: { type: "ephemeral" }`

5. **`src/agent/loop/AgentLoop.ts`**：每个 turn 把 `microCompactionEngine.cachedState.pendingMarkerUserMessageId` 传给 provider request `cacheBreakpointMessageIds`。

6. **`AnthropicResponseHandler`**：取 `usage.cache_creation_input_tokens` / `cache_read_input_tokens`，更新 `cachedState.baselineCacheDeletedTokens`。

7. **配置 + 关闭开关**：`PolitConfig.context.cachedMicrocompactEnabled = false` 默认；env override `POLITDECK_CACHED_MICROCOMPACT=1`。

#### 4.4.6 行为对齐 checklist

- [ ] 默认 disabled（feature gate 默认 false）
- [ ] 只在 Anthropic provider 上启用；其他 provider 完全 no-op
- [ ] 子代理（非 main_thread querySource）跳过 cached path
- [ ] time-based microcompact 命中时直接返回，不走 cached path
- [ ] COMPACTABLE_TOOLS 集合与 legacy 完全相同（9 个工具名）
- [ ] cache_control 标记加在被删 tool_use 之前的最近 user message
- [ ] usage `cache_creation_input_tokens` 被正确读取
- [ ] 连续 2 turn `cache_read_input_tokens` 严格大于 0（命中 cache）

#### 4.4.7 测试

```text
tests/context/cached-microcompact-state.test.ts        : state lifecycle
tests/context/cached-microcompact-non-main-thread.test : 子代理不进 cached path
tests/model/providers/anthropic/cache-control.test.ts  : breakpoint 加在正确位置
tests/agent/cached-microcompact-integration.test.ts    : end-to-end mock
tests/agent/e2e/real-cached-microcompact.test.ts (POLITDECK_RUN_REAL_CACHED_MC_E2E=1)
   : 真实 Anthropic API 验证 cache_read_input_tokens > 0
```

#### 4.4.8 工时与风险

- 实现：半天（约 4-5 小时）
- 风险：cache_control 加错位置 → cache miss 反而更贵 → e2e 必须看 token usage
- 风险：Kimi 等 OpenRouter 模型不支持 prompt cache → 默认 disable 保护

#### 4.4.9 输出

- 3 个新文件 + 2 个文件改动
- `politdeck-context-refactor-development-guide.md` §11 `context-cached-microcompact` deferred → resolved（feature gated）

---

### 4.5 A5 — Snip compact 策略

#### 4.5.1 是啥（大白话）

普通 compact 是"叫小模型总结一段话"。**snip 是"直接剪掉中间 N 条消息，只保留头尾 + boundary marker"**——零模型调用、瞬间完成，但损失更多信息。给追求速度 / 离线场景的 caller 一个选择。

#### 4.5.2 legacy 参考（`HISTORY_SNIP` 特性 + projection 路径）

legacy snip 是 model 显式调用 `SnipTool` 而非自动策略。当前 vendored 子树**只有 wiring**，`SnipTool/SnipTool.ts` 文件未收录。可参考的部分：

| legacy 路径 | 行为 |
| --- | --- |
| `src/tools.ts` line 125-126 | feature-gated `SnipTool = feature('HISTORY_SNIP') ? require('./tools/SnipTool/SnipTool.js').SnipTool : null` |
| `src/utils/messages.ts` line 4643-4656 `getMessagesAfterCompactBoundary` | option `includeSnipped`：默认通过 `projectSnippedView()` 隐藏被 snip 的段；transcript 模式下保留全量 |
| `src/services/compact/snipProjection.ts`（lazy require） | `projectSnippedView(messages)` 返回过滤掉被 snip 段的 view |
| `src/components/Message.tsx` line 251-256 | `isSnipBoundaryMessage(message)` 判定 |
| `src/utils/collapseReadSearch.ts` line 39 | snip prompt require lazy |

**关键观察**：legacy 是"model 用工具显式标记 snip 范围"，PolitDeck A5 是"context owner 自动按策略 snip"。**这是 intentional_difference**——但 boundary marker / projection 路径要保持 parity（让 transcript replay 一致）。

#### 4.5.3 当前 PolitDeck 骨架

- `src/context/compaction/CompactionEngine.ts`：只 summarize。
- `src/session/transcript/TranscriptEntry.ts`：有 `compact_boundary` / `microcompact_boundary`，**无 `snip_boundary`**。
- `src/session/transcript/TranscriptReplay.ts`：`findLastCompactBoundaryIndex` 已经存在。

#### 4.5.4 设计决策

| 决策 | 选择 |
| --- | --- |
| 触发模式 | **自动策略**（与 legacy `SnipTool` 不同；PolitDeck 不暴露 model 端 tool） |
| 配置项 | `PolitConfig.context.compactStrategy: "summarize" \| "snip"`（默认 `summarize`） |
| 保留范围 | `keepHeadTurns: 2` + `keepTailTurns: 4`（每"turn" = 一个 user + 对应 assistant + 完整 tool sequence） |
| Boundary 类型 | `snip_boundary`（与 `compact_boundary` 平级） |
| Tool pair 完整性 | **强制保留**：剪边界自动延展到 tool_use ↔ tool_result 完整对，不留 dangling |
| Replay 行为 | `findLastCompactBoundaryIndex` 升级支持 `snip_boundary`（同 compact 一致切片） |
| Projection 路径 | 加 `projectSnippedView(messages)` 与 legacy 同名，行为对齐 |
| Resume 兼容 | resume 一个含 snip_boundary 的 session → 正确切片，旧消息不上下文 |

#### 4.5.5 实现步骤

1. **`src/session/transcript/TranscriptEntry.ts`**：
   ```ts
   export type AgentControlBoundaryEntry = {
     type: "control_boundary";
     boundaryType: "compact" | "microcompact" | "snip";
     // ...
     snipMetadata?: {
       startIndex: number;     // 被剪段的原始 start
       endIndex: number;       // 原始 end (inclusive)
       removedEntryIds: string[];
       reason: "auto_strategy" | "manual";
     };
   };
   ```

2. **`src/session/transcript/JsonlTranscriptWriter.ts`** 加 `recordSnipBoundary(metadata)`。

3. **`src/session/transcript/TranscriptReplay.ts`** `findLastCompactBoundaryIndex` 支持 `snip` boundaryType。

4. **`src/context/compaction/SnipEngine.ts`**：

   ```ts
   export class SnipEngine {
     constructor(opts: { keepHeadTurns: number; keepTailTurns: number; transcript: AgentTranscriptWriter });
     snip(messages: CanonicalMessage[]): { messages: CanonicalMessage[]; removedCount: number };
   }
   ```

   实现步骤：
   - 把 messages 切成 turns（user + assistant + 完整 tool sequence 算 1 turn）
   - 计算 turns 数；`keepHead + keepTail >= total` → no-op
   - 从中间剪：保留 [0..keepHead) + [total - keepTail..total)
   - 检查切边在 tool_use ↔ tool_result 中间 → 延展边界到完整 turn
   - emit `snip_boundary` transcript entry + system message `<politdeck-snip-summary>剪除 K 条消息</politdeck-snip-summary>`

5. **`src/context/compaction/AutoCompactionPolicy.ts`**：
   - 加 `strategy: "summarize" | "snip"` 字段
   - 命中 trigger 阈值时根据 strategy 派发到 `CompactionEngine` 或 `SnipEngine`

6. **`src/context/compaction/snipProjection.ts`**：

   ```ts
   export function projectSnippedView(messages: CanonicalMessage[]): CanonicalMessage[];
   ```

   按 control_boundary `snipMetadata.removedEntryIds` 过滤。

#### 4.5.6 行为对齐 checklist

- [ ] 默认 strategy 是 `summarize`（不破坏现状）
- [ ] `keepHeadTurns=2 + keepTailTurns=4` 默认
- [ ] tool_use 和对应 tool_result 必须**一起被剪或一起被保留**（不出现 unpaired）
- [ ] snip 后写入 `snip_boundary` transcript entry
- [ ] resume 带 `snip_boundary` 的 session → replay 正确切片，不把被剪消息塞回 prompt
- [ ] `projectSnippedView` 返回的 view 内不含被剪消息
- [ ] turn-based 切分对 thinking-only assistant message（如 PTL retry 中间产物）也正确处理

#### 4.5.7 测试

```text
tests/context/compaction/snip-engine.test.ts
  : head/tail 保留 / tool pair 完整 / 不足 head+tail 时 no-op / thinking-only turn

tests/session/transcript/snip-boundary-replay.test.ts
  : findLastCompactBoundaryIndex 命中 snip / replay 切片正确

tests/context/compaction/snip-projection.test.ts
  : projectSnippedView 隐藏 / transcript 模式保留

tests/fixtures/context/dual-parity/snip-projection.scenarios.ts
  : 与 legacy `getMessagesAfterCompactBoundary({ includeSnipped: false })` 对齐（dual_parity）
```

#### 4.5.8 工时与风险

- 实现：半天
- 风险：tool_use ↔ tool_result 边界识别——必须用 message id 去匹配 pair，不能纯靠 index
- 风险：thinking-only assistant message（PTL retry 中间产物）的 turn 归属——单独算还是并入下一 user？决策：并入下一 user 同 turn

#### 4.5.9 输出

- 4 个新文件 + 3 个文件改动
- `politdeck-context-refactor-development-guide.md` §11 `context-snip-strategy` deferred → resolved

---

## 5. Tier B — 单 PR 半天到一天级

### 5.1 B1 — Adapter elicitation 协议 + ask_user_question 通道

#### 5.1.1 是啥（大白话）

让模型说"我有 3 个选项你选哪个"，**adapter（CLI / TUI / Feishu）能弹出选择 UI 收集答案给模型**。现在 `ask_user_question` 工具直接 throw `unsupported_tool`。

#### 5.1.2 legacy 参考（必须保留的 schema 和行为）

`third-party/claude-code-main/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`：

| 行 | 行为 |
| --- | --- |
| 14-17 `questionOptionSchema` | `{ label, description, preview? }`，preview 是可选的 mockup/code/HTML |
| 19-23 `questionSchema` | `{ question, header (max 16 chars chip), options[2-4], multiSelect (default false) }` |
| 32-54 `UNIQUENESS_REFINE` | 同 turn question texts 互不重复；options 同 question 内互不重复 |
| 62-67 `inputSchema` | 一次最多 4 个 question；`commonFields` 含 `answers`/`annotations`/`metadata` |
| 69-73 `outputSchema` | `{ questions, answers (Record<question, string\|csv>), annotations? }` |
| 113 `shouldDefer: true` | tool 调用 defer 到下一 turn 而非 inline 处理 |
| 135-145 `isEnabled()` | KAIROS / KAIROS_CHANNELS + getAllowedChannels().length > 0 → false（远端通道无人盯着） |
| 158-181 `validateInput` | preview 是 HTML 时校验：禁 `<html>/<body>/<!doctype>/<script>/<style>`；必须含 `<tag>` |
| 224-244 `mapToolResultToToolResultBlockParam` | 输出格式：`User has answered your questions: "Q1"="A1" selected preview:\n<html> user notes: ..., "Q2"="A2"`（CSV 逗号连接） |
| 200-204 `renderToolUseRejectedMessage` | "User declined to answer questions" 提示 |

**`elicitationHandler.ts`**（MCP 同套机制）：
- `runElicitationHooks(request)` / `runElicitationResultHooks(result)`：让 hooks 拦截 / 改写
- `ElicitationWaitingState`：等待中 UI 状态（防双开）

#### 5.1.3 当前 PolitDeck 骨架

- `src/tool/builtin/askUserQuestion.ts`：schema 已定义但 execute throw `unsupported_tool`。
- `src/adapters/channel/{cli,tui,feishu}/`：无 elicitation 接口。

#### 5.1.4 设计决策

| 决策 | 选择 |
| --- | --- |
| 通道接口位置 | `src/adapters/elicitation/ElicitationChannel.ts` |
| 注入路径 | `PolitDeckToolRuntimeContext.elicitation?` |
| schema 对齐 | **完全对齐 legacy** schema（含 preview / annotations / multiSelect / 1-4 questions / 2-4 options） |
| `shouldDefer` 行为 | **必做**（与 legacy 一致）：tool 标 deferred，scheduler 把所有 deferred tool 推到 turn 末尾再执行 |
| HTML preview 校验 | **必做**（防 XSS） |
| 输出格式 | 完全对齐 legacy `mapToolResultToToolResultBlockParam` |
| `isEnabled()` | adapter 通道无 `canPrompt` 能力时整个 tool unavailable |
| timeout | 默认 5 分钟（legacy 没有显式 timeout，但 PolitDeck adapter 远端连接需要保护） |
| cancel 语义 | adapter 主动 cancel → 返回 `behavior: "rejected"` 等同于"用户拒绝" |

**API**：

```ts
export interface PolitDeckElicitationChannel {
  askUser(request: PolitDeckElicitationRequest): Promise<PolitDeckElicitationResult>;
}

export type PolitDeckElicitationRequest = {
  requestId: string;
  questions: Array<{
    id: string;
    prompt: string;       // 完整问句
    header: string;       // 短 chip 标签 (≤16 chars)
    options: Array<{
      id: string;
      label: string;
      description?: string;
      preview?: string;
    }>;
    allowMultiple?: boolean;
  }>;
  metadata?: Record<string, string>;
  timeoutMs?: number;    // default 300000
  abortSignal?: AbortSignal;
};

export type PolitDeckElicitationResult =
  | { requestId: string; status: "answered"; answers: Record<string, string[]>;
      annotations?: Record<string, { preview?: string; notes?: string }> }
  | { requestId: string; status: "rejected"; reason?: string }
  | { requestId: string; status: "timeout" };
```

#### 5.1.5 实现步骤

1. **`src/adapters/elicitation/ElicitationChannel.ts`**：上面接口 + types。
2. **`src/adapters/elicitation/htmlPreviewValidator.ts`**：与 legacy `validateHtmlPreview` 完全对齐（同 3 条规则）。
3. **`src/tool/protocol/types.ts`**：`PolitDeckToolRuntimeContext.elicitation?: PolitDeckElicitationChannel`。
4. **`src/tool/scheduler/SequentialToolScheduler.ts`** 实装 `shouldDefer` 语义：标记 deferred 的 tool 放到队尾再执行。
5. **`src/tool/builtin/askUserQuestion.ts`** 重写：
   - schema 对齐 legacy（1-4 questions、2-4 options、uniqueness refine）
   - `shouldDefer = true`
   - `validateInput` 调 htmlPreviewValidator
   - `execute`：context.elicitation 缺 → `unsupported_tool`；调 `askUser`，根据 status 返回 OK 或 reject
   - 输出格式与 legacy `mapToolResultToToolResultBlockParam` 字符串完全一致

6. **`src/adapters/channel/cli/CliElicitationChannel.ts`**：
   - 用 `readline` 异步 prompt
   - 单选：列编号选项 → 输入数字
   - 多选：输入逗号分隔编号
   - 5 分钟 timeout
   - `\C-c` → status: rejected

7. **`src/adapters/channel/tui/TuiElicitationChannel.ts`**：
   - 通过 Gateway event 推 `elicitation_request`
   - TUI Ink modal 处理（已有 modal 容器）
   - 答案通过 `elicitation_answer` 回执

8. **`src/adapters/channel/feishu/FeishuElicitationChannel.ts`**：
   - 飞书 interactive card 含 button options
   - card_action callback → resolve promise（用 requestId 关联）

9. **`src/gateway/protocol/types.ts`** 加 `elicitation_request` / `elicitation_answer` 双向消息（与 cron owner 2026-05-09 确认前缀边界：`elicitation_*` 与 `cron_*` 命名空间互不重叠，可并存 PR）。具体 wire schema：

   ```ts
   // server → client
   type ElicitationRequestMessage = {
     type: "elicitation_request";
     requestId: string;
     sessionKey: string;             // 与 cron submitTurn 同一识别键，未来共用
     payload: PolitDeckElicitationRequest;
   };
   // client → server
   type ElicitationAnswerMessage = {
     type: "elicitation_answer";
     requestId: string;
     payload: PolitDeckElicitationResult;
   };
   ```

   注意：当前 `src/gateway/protocol/types.ts` 不是 `*_request` union，而是 Gateway interface + WS method（cron owner 确认）。本 feature 不重构整个协议结构，**只在 Gateway interface 加 `sendElicitationRequest()` / `onElicitationAnswer()` 两个方法**，与 cron owner 添加的 `cron_*` 方法平行；wire 层用 `type: "elicitation_*"` 字段做 dispatch。

10. **`src/extension/hooks/`** 加 `pre_elicitation` / `post_elicitation` hook（与 legacy `runElicitationHooks` 对齐）。

#### 5.1.6 行为对齐 checklist

- [ ] 输入 schema 1-4 questions / 2-4 options
- [ ] header 字段 ≤16 chars
- [ ] question texts 同 turn 互不重复
- [ ] option labels 同 question 内互不重复
- [ ] HTML preview 校验（无 `<html>/<body>/<script>/<style>`，必须含 tag）
- [ ] `shouldDefer: true`，被 scheduler 推到 turn 末尾
- [ ] adapter 无 elicitation channel → `unsupported_tool`
- [ ] adapter cancel → status: rejected
- [ ] 5 min timeout → status: timeout
- [ ] 输出字符串与 legacy `mapToolResultToToolResultBlockParam` 完全一致
- [ ] 远端通道（KAIROS / Feishu only）无人盯时 `isEnabled` = false

#### 5.1.7 测试

```text
tests/tool/builtin-ask-user-question.test.ts
  : input schema validate / shouldDefer / execute via fake channel / unsupported_tool / output format

tests/adapters/elicitation/cli.test.ts
  : readline mock / single + multi select / cancel / timeout

tests/adapters/elicitation/tui.test.ts
  : Gateway event 推送 + 接收 answer

tests/adapters/elicitation/feishu.test.ts
  : card action callback 关联 requestId

tests/fixtures/tool/dual-parity/ask-user-question.scenarios.ts
  : 与 legacy mapToolResultToToolResultBlockParam 输出对齐 (dual_parity)
```

#### 5.1.8 工时

- 协议 + 工具 + CLI：4 h
- TUI：2 h
- Feishu：2 h
- 测试：3 h
- 合计：~1.5 天

#### 5.1.9 输出

- 5 个新文件（接口 + 3 channel impl + validator）
- 3 个文件改动（tool / scheduler / Gateway）
- 4 个测试文件 + 1 parity scenarios
- `politdeck-tool-refactor-development-guide.md` §13.X ask_user_question deferred → resolved

---

### 5.2 B2 — Web fetch 完整版

#### 5.2.1 是啥（大白话）

模型说"读这个 URL，告诉我发布日期"，工具去抓 → HTML→Markdown → **调小模型按 prompt 提取**（不直接塞 100KB 进 context） → 把摘要返回主模型。

#### 5.2.2 legacy 参考（必须保留的 13 个安全/性能行为）

`third-party/claude-code-main/src/tools/WebFetchTool/utils.ts` + `WebFetchTool.ts` + `preapproved.ts`：

| 编号 | 行为 | legacy 行 |
| --- | --- | --- |
| W1 | URL 长度上限 2000 chars | utils.ts:106 `MAX_URL_LENGTH` |
| W2 | URL 校验：拒绝 username/password / hostname 必须含 dot | utils.ts:139-168 `validateURL` |
| W3 | http → https 自动升级 | utils.ts:376-379 |
| W4 | 内容大小上限 10 MB | utils.ts:112 `MAX_HTTP_CONTENT_LENGTH` |
| W5 | 请求 timeout 60s | utils.ts:116 `FETCH_TIMEOUT_MS` |
| W6 | 自定义 redirect handling：仅同 origin（含 www add/remove）；max 10 hops | utils.ts:212-243 `isPermittedRedirect` + line 122-125 `MAX_REDIRECTS` |
| W7 | URL LRU 缓存 50 MB / 15 min TTL，key=**原始 URL**（不是升级后） | utils.ts:62-69 |
| W8 | Domain check 缓存（只缓存 'allowed'）5 min TTL | utils.ts:75-78 |
| W9 | Egress proxy 检测：`X-Proxy-Error: blocked-by-allowlist` 抛 `EgressBlockedError` | utils.ts:316-325 |
| W10 | Binary content（PDF / image）persist 到磁盘 + 仍尝试 utf-8 decode | utils.ts:435-448 |
| W11 | HTML → Markdown 用 turndown（lazy singleton，避免 1.4MB 启动开销） | utils.ts:90-97 |
| W12 | Markdown 长度上限 100 K chars，超过截断标 `[Content truncated due to length...]` | utils.ts:128 `MAX_MARKDOWN_LENGTH`，line 491-496 |
| W13 | Secondary model（Haiku / 主模型）按 prompt 提取，**不把全文塞主 context** | utils.ts:484-530 `applyPromptToMarkdown` |

**preapproved.ts** ~167 个域名（编程语言 / 框架 / docs 站点）：完整 list 必须移植。

**`makeSecondaryModelPrompt` 行为**（prompt.ts，未读到完整内容但可推）：拼一个固定模板让 secondary model 提取信息。

#### 5.2.3 当前 PolitDeck 骨架

- `src/tool/builtin/webFetch.ts`：始终 throw `unsupported_tool`。
- `PolitDeckToolModelClient`（T1 完成）已经允许工具内调 model。

#### 5.2.4 设计决策

| 决策 | 选择 |
| --- | --- |
| HTML→Markdown lib | **turndown**（与 legacy 同；70 KB gzip） |
| DOM polyfill | turndown 自带 jsdom-lite；**不引** `@mixmark-io/domino`（PolitDeck 不需要 1.4MB heap 优化） |
| HTTP client | **Node 内置 fetch + AbortSignal**（不引 axios）；redirect=`manual` 自己实现 W6 |
| LRU 缓存 | **自己写**（Map + ttl + sizeCap），不引依赖 |
| Domain blocklist preflight (W8 Anthropic API) | **不做**（PolitDeck 无 Anthropic API binding；intentional_difference）；用本地 ALLOWED/BLOCKED env 列表替代 |
| Preapproved 域名 list | **完整移植** legacy preapproved.ts |
| Secondary model | 默认走 `context.model`（T1 注入）；可选 `createWebFetchTool({ secondaryModel: "kimi-fast" })` 覆盖 |
| Markdown 截断 | **必做** 100 K chars + `[Content truncated due to length...]` 标记 |
| Persist binary | **必做** 落到 `~/.politdeck/projects/<id>/sessions/<sid>/web-fetch/<id>` |
| `shouldDefer: true` | **必做**（与 legacy 一致） |
| Egress detect | **必做**（W9） |

**API**：

```ts
type WebFetchInput = { url: string; prompt: string };
type WebFetchOutput = {
  url: string;
  code: number;
  codeText: string;
  bytes: number;
  contentType: string;
  durationMs: number;
  result: string;       // secondary model 提取结果
  persistedPath?: string;
  persistedSize?: number;
};
```

#### 5.2.5 实现步骤

1. **依赖**：`npm install turndown @types/turndown`。
2. **`src/tool/builtin/webFetch/preapproved.ts`**：完整复制 legacy `PREAPPROVED_HOSTS` set + `isPreapprovedHost(hostname, pathname)`。
3. **`src/tool/builtin/webFetch/validateURL.ts`**：W1 + W2 完整对齐。
4. **`src/tool/builtin/webFetch/redirect.ts`**：`isPermittedRedirect` + `getWithPermittedRedirects` 自己写 fetch 版本（用 Node 内置 fetch + manual redirect）。
5. **`src/tool/builtin/webFetch/turndown.ts`**：lazy singleton。
6. **`src/tool/builtin/webFetch/lruCache.ts`**：自己写 LRU + TTL + size cap。
7. **`src/tool/builtin/webFetch/persistBinary.ts`**：检测 binary content-type + 写到 sessionStorage path。
8. **`src/tool/builtin/webFetch/secondaryPrompt.ts`**：完全对齐 legacy `makeSecondaryModelPrompt(content, prompt, isPreapprovedDomain)`。
9. **`src/tool/builtin/webFetch.ts`** 主入口重写：
   - validateURL → 不通过抛 `invalid_request`
   - 检查 LRU cache → 命中跳过 fetch
   - http→https
   - getWithPermittedRedirects(url, signal, isPermittedRedirect)
   - 解析 content-type → HTML 走 turndown / 其他直接 utf-8 decode
   - 二进制 → persistBinary
   - markdown 截断到 100K
   - 调 `context.model.completeText({ system, messages: [{ role:"user", content: makeSecondaryModelPrompt(...) }] })`
   - 返回 WebFetchOutput
   - permission：preapproved → allow_once；非预审 → ask
10. **测试**。

#### 5.2.6 行为对齐 checklist

- [ ] URL > 2000 chars → reject
- [ ] URL 含 user/pass → reject
- [ ] URL hostname 单段（如 `localhost`）→ reject
- [ ] http URL 自动升级 https
- [ ] Same-origin redirect 跟（最多 10 hops）
- [ ] Cross-origin redirect 不跟，返回 redirect info
- [ ] 同站 www 加减允许
- [ ] >10 MB 内容 reject
- [ ] >60s 超时 reject
- [ ] LRU cache 50 MB cap，15 min TTL
- [ ] LRU key 是原始 URL（不是升级或 redirect 后）
- [ ] Binary content 保存到磁盘 + 仍尝试 utf-8 decode（PDF 有 ASCII 结构）
- [ ] HTML 走 turndown
- [ ] Markdown 超 100 K chars 截断
- [ ] Secondary model 调用走 `context.model`
- [ ] Egress block (X-Proxy-Error header) 抛 EgressBlockedError
- [ ] preapproved 域名 167 个全部生效
- [ ] preapproved 域名跳过 ask permission

#### 5.2.7 测试

```text
tests/tool/builtin/web-fetch/preapproved.test.ts
tests/tool/builtin/web-fetch/validate-url.test.ts
tests/tool/builtin/web-fetch/redirect.test.ts
tests/tool/builtin/web-fetch/lru-cache.test.ts
tests/tool/builtin/web-fetch/turndown.test.ts
tests/tool/builtin/web-fetch/integration.test.ts  : mock fetch + model
tests/tool/e2e/real-web-fetch.test.ts (POLITDECK_RUN_REAL_WEB_FETCH_E2E=1)
```

#### 5.2.8 工时与风险

- 实现：1 天
- 风险：turndown 跟 Node 22 兼容性 → benchmark
- 风险：fetch redirect=manual 在 Node 22 行为差异 → 仔细处理 location header

#### 5.2.9 输出

- 9 个新文件 + 1 改动 + 6 个测试 + 1 e2e
- `politdeck-tool-refactor-development-guide.md` §13.X web_fetch 章节升级

---

### 5.3 B3 — MCP instructions 注入（read-only 单独路径）

#### 5.3.1 是啥（大白话）

MCP server 启动后会返回一段 server instructions（"使用本 server 时请..."），需要塞到 systemPrompt 里。**先做 read-only：从 manifest 静态读 instructions，不做真实连接**——这样 context owner 不用等 C1（完整 MCP runtime）。

#### 5.3.2 legacy 参考

| legacy 路径 | 行为 |
| --- | --- |
| `services/mcp/client.ts` line 215-218 `MAX_MCP_DESCRIPTION_LENGTH = 2048` | server instructions 超长截断到 2048 chars（OpenAPI-generated server 经常 dump 15-60 KB） |
| `services/mcp/client.ts` line 1801-1803 | tool description 同样的 2048 截断逻辑 |
| `services/mcp/types.ts` `ConnectedMCPServer.serverInstructions` | 运行时字段；连接后从 `initialize` response 读 |
| `utils/attachments.ts` `getMcpInstructionsDeltaAttachment` | 把 instructions 包成 attachment 注入 user message |
| `services/compact/compact.ts` line 27 import | compact 后 re-inject delta（保持上下文） |

**legacy 行为关键点**：
1. instructions 是**运行时**从 server `initialize` 拿，不是静态。
2. 长度截断 2048 chars。
3. 通过 attachment 而非 systemPrompt 注入（attachment = user 角色的"本 turn 上下文"）。
4. compact 后 delta 重新注入。

#### 5.3.3 当前 PolitDeck 骨架

- `src/extension/plugins/runtime/PluginRuntime.ts` 已经有 `mcpServers()` 静态聚合。
- `src/context/extension/PluginRuntimeExtensionResolver.ts` 实装了 commands / skills；**未实装 instructions**。
- `src/context/attachments/AttachmentResolver.ts` 已经有 attachment 注入路径。
- `src/context/prompt/PromptAssembler.ts` 5 段 layout 含 `systemContext` 段。

#### 5.3.4 设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 数据源 | manifest 静态字段（**read-only**） | C1 完成前用；C1 完成后接运行时数据源 |
| 注入位置 | **systemContext 段**（不是 attachment） | static instructions 不会变；走 attachment 反而每 turn 重发 |
| 长度截断 | 2048 chars（与 legacy 一致） | OpenAPI 生成的 server 通常 dump 一大段 |
| Manifest schema | `mcpServers[i].instructions?: string` | 静态可选字段 |
| 接口 | `ExtensionResolver.getMcpInstructions()` | 返回 `Array<{ serverId; instructions: string }>` |
| C1 升级路径 | C1 落地后改 `PluginToToolBridge` 维护 `runtimeInstructions` map，`getMcpInstructions()` 优先返回 runtime 值 fall back 到 manifest | 双源切换无需改 PromptAssembler |

#### 5.3.5 实现步骤

1. **`src/extension/plugins/protocol/manifest.ts`**：

   ```ts
   export type PolitDeckMcpServerContribution = {
     id: string;
     // ... 已有字段
     instructions?: string;     // 静态 instructions，可选
   };
   ```

2. **`src/extension/plugins/runtime/PluginRuntime.ts`**：

   ```ts
   mcpInstructions(): Array<{ serverId: string; instructions: string }> {
     return this.registry.list().flatMap(plugin =>
       Object.entries(plugin.mcpServers ?? {})
         .filter(([_, server]) => typeof (server as any).instructions === "string")
         .map(([id, server]) => ({
           serverId: id,
           instructions: truncateMcpString((server as any).instructions),
         })),
     );
   }
   ```

3. **`src/extension/plugins/runtime/truncateMcpString.ts`**：与 legacy 相同截断逻辑：

   ```ts
   const MAX = 2048;
   export function truncateMcpString(s: string): string {
     return s.length > MAX ? s.slice(0, MAX) + "… [truncated]" : s;
   }
   ```

4. **`src/context/extension/ExtensionResolver.ts`**：接口加 `getMcpInstructions(): Promise<Array<{ serverId; instructions }>>`。
5. **`src/context/extension/PluginRuntimeExtensionResolver.ts`** 实装。
6. **`src/context/extension/NullExtensionResolver.ts`** 返回 `[]`。
7. **`src/context/prompt/PromptAssembler.ts`**：在 systemContext section 后追加 mcp_instructions 块，格式：

   ```text
   <mcp-instructions>
   <server name="figma">
   ...instructions...
   </server>
   <server name="github">
   ...instructions...
   </server>
   </mcp-instructions>
   ```

8. **测试**。

#### 5.3.6 行为对齐 checklist

- [ ] manifest 无 instructions 字段 → 不渲染 mcp-instructions 块
- [ ] manifest 有 instructions → systemPrompt 含 `<mcp-instructions>`
- [ ] 单个 instructions > 2048 chars 截断 + `… [truncated]` 标
- [ ] 多 server 时按 serverId 字典序稳定排序（避免 prompt cache 抖动）
- [ ] 与 commands / skills section 顺序固定（PromptAssembler 5 段 layout 不破）
- [ ] C1 落地后接运行时 instructions 时无需改 PromptAssembler

#### 5.3.7 测试

```text
tests/extension/plugin-mcp-instructions.test.ts          : truncate / multi-server / 排序
tests/context/prompt-assembler-mcp-instructions.test.ts  : 渲染位置 + 格式
tests/context/extension-resolver-mcp.test.ts             : 接口契约
```

#### 5.3.8 工时与风险

- 实现：半天（接口 + 渲染 + 测试）
- 风险：C1 完成后必须改实装路径，不能让两份 instructions 同时存在 → 留 TODO 标注

#### 5.3.9 输出

- 4 个新文件 + 3 改动 + 3 测试
- `politdeck-context-refactor-development-guide.md` §11 `context-mcp-instructions` deferred → partial（read-only 完成；C1 后升级 runtime）

---

## 6. Tier C — 1 ~ 2 天级新模块

### 6.1 C1 — MCP runtime（connect / list / call）

#### 6.1.1 是啥（大白话）

让 PolitDeck 能**真的去启动 / 连接外部 MCP server**（subprocess / SSE / WebSocket / streamable-http），收下 server 的 tool 列表注册到 ToolRegistry，转发 tool call。

#### 6.1.2 legacy 参考（必须保留的 16 个行为）

`third-party/claude-code-main/src/services/mcp/client.ts` (3353 行) 是参考蓝本——**不直接搬代码**，但行为契约：

| 编号 | legacy export | 行为 |
| --- | --- | --- |
| M1 | `connectToServer` (line 585) memoized | 同 (name, config) 的 client 复用 |
| M2 | 4 种 transport：stdio / SSE / streamableHTTP / WebSocket | line 663+；SDK 提供 |
| M3 | `wrapFetchWithTimeout` (line 482) | 60s default per-request timeout（SSE EventSource 不应用） |
| M4 | `getMcpServerConnectionBatchSize` (line 542) | 多 server 并发 connect 限制（避免 spawn 风暴） |
| M5 | `ensureConnectedClient` (line 1698) | 连接掉了自动重连 |
| M6 | `fetchToolsForClient` (line 1753) memoizeWithLRU | tools/list 结果缓存；包装成 `Tool` |
| M7 | `fetchResourcesForClient` (line 2005) | resources/list |
| M8 | `fetchCommandsForClient` (line 2038) | prompts/list |
| M9 | `recursivelySanitizeUnicode` (line 1768) | 防 unicode 攻击 |
| M10 | tool name = `mcp__<server>__<tool>` (line 1778 `buildMcpToolName`) | wire 命名 |
| M11 | tool description 截断 2048 chars (line 1801, `MAX_MCP_DESCRIPTION_LENGTH`) | OpenAPI server 大量描述 |
| M12 | `tool.annotations.readOnlyHint / destructiveHint / openWorldHint` 透传 | 影响 permission |
| M13 | `_meta.anthropic/searchHint` / `_meta.anthropic/alwaysLoad` 透传 | tool 索引 |
| M14 | `transformResultContent` (line 2483) / `transformMCPResult` / `processMCPResult` | tool result 大文件 persist 到磁盘 |
| M15 | `isMcpSessionExpiredError` (line 193) | 404 + JSON-RPC -32001 → 自动重连 |
| M16 | `MCP_TOOL_TIMEOUT` env var | 默认 ~27.8 hours（很大） |

**OAuth 部分**（line 130-133 `ClaudeAuthProvider` / `wrapFetchWithStepUpDetection` / `auth.ts`）→ **本 PR 不做**（D 类）。

#### 6.1.3 当前 PolitDeck 骨架

- `src/tool/builtin/mcpTool.ts`：仅 `createMcpTool()` 包装器 + `PolitDeckMcpToolAdapter` 抽象接口。
- 无 `src/mcp/`。

#### 6.1.4 设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| SDK | `@modelcontextprotocol/sdk` 依赖（pin stable） | 业界标准 |
| 本轮 transport 范围 | **stdio + streamable-http**（覆盖 95% 用例） | SSE / WebSocket 留 stub；OAuth 留 D 类 |
| Connect 并发 | 5 server 并发 connect | M4 |
| Per-call timeout | env `POLITDECK_MCP_TOOL_TIMEOUT_MS` 默认 60_000（不复刻 legacy 27.8h 默认；过大易被 stuck） | 与 legacy intentional_difference |
| LRU 缓存 tools/list | LRU 32 entries + 5 min TTL | M6 |
| Description 截断 | **必做** 2048 chars | M11 |
| Wire 命名 | `mcp__<server>__<tool>` | M10 |
| 自动重连 | 检测 session expired (M15) → close + reconnect once | 保险 |
| Permission | tool.annotations 反映到 `isReadOnly` / `isDestructive`（M12） | 与 PolitDeck permission engine 协作 |
| Tool result 大文件 | M14：>maxResultBytes 时 persist 到 ToolResultBudget 已有的磁盘 | 复用现有路径 |
| Elicitation | 接 B1 ElicitationChannel（C1 完成时 B1 已 ready） | MCP `elicitRequest` 直接转 PolitDeckElicitationChannel |
| 命名空间 | `mcp_handshake_failed` / `mcp_session_expired` / `mcp_call_timeout` 错误码 | 与 §1.3 一致 |

#### 6.1.5 实现步骤

1. **`npm install @modelcontextprotocol/sdk`** + pin。
2. **`src/mcp/protocol/types.ts`**：

   ```ts
   export type PolitDeckMcpServerSpec =
     | { id: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string,string> }
     | { id: string; transport: "streamable_http"; url: string; headers?: Record<string,string> };
   export type PolitDeckMcpToolSpec = {
     serverId: string; toolName: string; wireName: string;
     description: string; inputSchema: unknown;
     annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
     meta?: Record<string, unknown>;
   };
   export type PolitDeckMcpStatus = "idle" | "connecting" | "ready" | "error" | "needs-auth";
   ```

3. **`src/mcp/transport/StdioTransport.ts`** / **`HttpTransport.ts`**：包装 SDK 提供的 `StdioClientTransport` / `StreamableHTTPClientTransport`。
4. **`src/mcp/client/McpClient.ts`**：
   - constructor(spec, opts)
   - `connect(timeoutMs=10_000)` → throw `mcp_handshake_failed`
   - `listTools()` LRU memoize
   - `callTool(name, input, signal)` 60s default timeout，session expired → 自动 reconnect once
   - `close()` cleanup

5. **`src/mcp/runtime/McpRuntime.ts`**：
   - constructor 接 `servers: PolitDeckMcpServerSpec[]` + `elicitation?: ElicitationChannel`（B1）
   - `start()`：5 并发 connect，记录每个 server status
   - `getTool(wireName)` → 转发 callTool
   - `listAllTools()` → 用于 ToolRegistry 注册
   - `getInstructions()`：从已 connect 的 server 拿运行时 instructions（替换 B3 静态值）
   - `stop()` cleanup all

6. **`src/mcp/runtime/sanitize.ts`**：复刻 `recursivelySanitizeUnicode`（M9）。
7. **`src/mcp/runtime/PluginToToolBridge.ts`**：
   - 把 `PolitDeckMcpToolSpec` 转成 `PolitDeckToolDefinition`（用 `createMcpTool()` 包装）
   - `isReadOnly` / `isDestructive` / `isOpenWorld` 来自 annotations
   - description 截断 2048
   - `execute` 调 `runtime.callTool`，结果走 `transformResultContent`（大文件 persist）

8. **`src/tool/registry/createBuiltinRegistry.ts`** 接 `mcpRuntime?: McpRuntime` 参数，启动时注册所有 MCP tool。
9. **`src/context/extension/PluginRuntimeExtensionResolver.ts`** 升级：
   - 优先用 `mcpRuntime.getInstructions()`（运行时）
   - fallback 到 manifest 静态（B3 路径）
10. **测试**。

#### 6.1.6 行为对齐 checklist

- [ ] stdio server connect 走子进程 spawn；进程退出后 client 标 error
- [ ] streamable-http 走 fetch；wrapFetchWithTimeout 60s
- [ ] connect 失败 → `mcp_handshake_failed` 错误码
- [ ] tools/list 同 client 5 min 内缓存
- [ ] tool.description > 2048 → 截断 + `… [truncated]` 标
- [ ] tool.annotations.readOnlyHint = true → `isReadOnly() = true`
- [ ] callTool session expired (404 + -32001) → 自动重连一次
- [ ] callTool 60s 超时 → `mcp_call_timeout`
- [ ] tool result > maxResultBytes → 走 ToolResultBudget persist 路径
- [ ] elicitRequest（来自 server）→ 转 ElicitationChannel.askUser
- [ ] runtime stop → 所有 client.close()，无 zombie 子进程
- [ ] OAuth → 直接返回 needs-auth status，不实装

#### 6.1.7 测试

```text
tests/mcp/stdio-transport.test.ts        : fake stdio server (Node script) echo
tests/mcp/http-transport.test.ts         : mock fetch
tests/mcp/client-reconnect.test.ts       : session expired auto-reconnect
tests/mcp/runtime-tool-registration.test : 多 server / 并发 connect
tests/mcp/sanitize.test.ts               : unicode 攻击 fixture
tests/mcp/elicitation-bridge.test.ts     : elicitRequest → askUser
tests/fixtures/mcp/dual-parity/wire-name.scenarios.ts (dual_parity)
tests/mcp/e2e/real-figma.test.ts         : POLITDECK_RUN_REAL_MCP_E2E=1
```

**fake stdio MCP server** (~30 行 Node script) 放 `tests/fixtures/mcp/echo-server.mjs`，跟 client 通过 stdin/stdout JSON-RPC 通信。

#### 6.1.8 工时与风险

- 实现：1.5-2 天
- 风险：`@modelcontextprotocol/sdk` 版本兼容性 → pin 后定期升级
- 风险：streamable-http 协议在 SDK 内部 schema 变化 → 测试覆盖关键路径

#### 6.1.9 输出

- 10+ 个新文件（protocol / 2 transport / client / runtime / bridge / sanitize 等）
- 1 改动（builtin registry）+ 1 改动（PluginRuntimeExtensionResolver 升级）
- 8 个测试文件 + 1 e2e
- B3 升级：`context-mcp-instructions` partial → resolved
- `politdeck-tool-refactor-development-guide.md` §13.X mcp__* 章节升级

---

### 6.2 C2 — Subagent fork full

#### 6.2.1 是啥（大白话）

让 `agent` 工具的子代理**真正跑一个完整 Agent loop**：自己消费工具、维护上下文、做决策，最后给主 agent 一个汇总报告。同时**继承父 session 的部分 context**（cache-safe 复用）+ 限定 tool pool。

#### 6.2.2 legacy 参考（必须保留的 12 个行为）

`third-party/claude-code-main/src/tools/AgentTool/forkSubagent.ts` + `runAgent.ts` + `built-in/`：

| 编号 | 行为 | legacy 行 |
| --- | --- | --- |
| S1 | `buildForkedMessages(directive, assistantMessage)`：保留父全 assistant msg（含 thinking + 所有 tool_use）+ 构造 user msg 含 `tool_result` placeholder for each tool_use + 末尾 directive text block | forkSubagent.ts 107-168 |
| S2 | `FORK_PLACEHOLDER_RESULT` 占位字符串恒定 → 同 byte-prefix → cache 命中 | line 148 |
| S3 | `buildChildMessage(directive)` 模板包 `<fork>` boilerplate + 10 条规则 + `Output format` + directive | line 171-198 |
| S4 | `filterIncompleteToolCalls(forkContextMessages)` 剔除残缺的 tool_use（防 API 报错） | runAgent.ts 371 |
| S5 | `cloneFileStateCache(parent.readFileState)` 隔离 fileState（subagent 不污染父） | runAgent.ts 377 |
| S6 | `getUserContext()` / `getSystemContext()` 同父；可 override | runAgent.ts 380-383 |
| S7 | `agentDefinition.omitClaudeMd === true && !override` → 删 claudeMd context（slim subagent） | runAgent.ts 390-398 |
| S8 | `Explore` / `Plan` agent 删 gitStatus（read-only 不需要） | runAgent.ts 404-410 |
| S9 | `agentDefinition.permissionMode` 覆盖；除非父在 `bypassPermissions/acceptEdits/auto` | runAgent.ts 415-433 |
| S10 | `isAsync` agent 强制 `shouldAvoidPermissionPrompts: true`；async + canShowPrompts → `awaitAutomatedChecksBeforeDialog` | runAgent.ts 440-463 |
| S11 | `allowedTools` 限定 → `alwaysAllowRules.session = allowedTools`，保留父 cliArg | runAgent.ts 469-478 |
| S12 | `agentDefinition.effort` 覆盖 reasoning effort | runAgent.ts 481-484 |

**3 个 built-in agents**（`src/tools/AgentTool/built-in/*Agent.ts`）：
- `general-purpose`：`tools: ['*']`，无 omitClaudeMd
- `explore`：限读 / grep / glob / bash，omitClaudeMd: true
- `plan`：限读 / grep / glob，omitClaudeMd: true，readonly

**Subagent 输出约定**（child message 模板 line 188-198）：

```text
Scope: <one sentence>
Result: <findings>
Key files: <paths>
Files changed: <list with commit hash>
Issues: <list>
```

**system prompt 共享前缀** (`generalPurposeAgent.ts` line 3-16)：

```text
You are an agent for [...]. Given the user's message, [...].
Strengths: [...]
Guidelines: [...]
NEVER create files unless [...]
NEVER proactively create documentation [...]
```

#### 6.2.3 当前 PolitDeck 骨架

- `src/tool/builtin/agent.ts` 现在已经是"单 turn 子 model 调用"，**不是真正 fork**。
- 没有 `src/agent/sub/`。

#### 6.2.4 设计决策

| 决策 | 选择 |
| --- | --- |
| 入口 | 重写 `src/tool/builtin/agent.ts` |
| 内部 | 复用 `AgentLoop`（不写另一份），跑一个 `SubAgentSession` |
| Context inherit | **走 cache-safe path**（S1-S2）：完整保留父 assistant msg + placeholder tool_result + child directive text block |
| 占位字符串 | `<politdeck-fork-placeholder>子任务执行中...</politdeck-fork-placeholder>`（恒定，确保 cache 同字节） |
| Built-in subagent_types | `general-purpose` / `explore` / `plan`（与 legacy 同 3 个） |
| Tool pool 限定 | 与 legacy 同 |
| readFileState 隔离 | 必做（S5）；但 PolitDeck 当前 `ReadTextFile` 维护自己 cache，需要隔离 |
| omitClaudeMd | 与 legacy 同（explore / plan 删除） |
| 删 gitStatus for explore/plan | 与 legacy 同 |
| 递归限制 | `maxSubagentDepth=1`（防爆炸） |
| Permission mode | 与 legacy S9-S11 完全对齐 |
| 输出格式 | child message 规则（S3）+ 5 字段输出 |
| Async vs sync | 本 PR **同步阻塞主 turn**；C5 落地后 `background: true` 可改异步 |
| Worktree | 不在本 PR 做（legacy `buildWorktreeNotice` 留给 worktree feature） |
| Token usage | subagent usage 累加到父 session（不双重计算） |

#### 6.2.5 实现步骤

1. **`src/agent/sub/builtinSubagentTypes.ts`**：

   ```ts
   const SHARED_PREFIX = "You are a subagent for PolitDeck...";  // 完整对齐 legacy
   const SHARED_GUIDELINES = "...";                              // 完整对齐 legacy

   export const SUBAGENT_TYPES: Record<string, SubagentDefinition> = {
     "general-purpose": { allowedTools: ["*"], omitClaudeMd: false, isReadOnly: false, ... },
     "explore":         { allowedTools: ["file_read","grep","glob","bash"], omitClaudeMd: true, isReadOnly: true, omitGitStatus: true, ... },
     "plan":            { allowedTools: ["file_read","grep","glob"], omitClaudeMd: true, isReadOnly: true, omitGitStatus: true, ... },
   };
   ```

2. **`src/agent/sub/buildForkedMessages.ts`**：完全对齐 S1-S3：

   ```ts
   export const FORK_PLACEHOLDER_RESULT = "<politdeck-fork-placeholder>子任务执行中...</politdeck-fork-placeholder>";
   export const FORK_BOILERPLATE_TAG = "fork";

   export function buildForkedMessages(directive: string, assistantMessage: CanonicalAssistantMessage): CanonicalMessage[];
   export function buildChildMessage(directive: string): string;  // 含 10 条规则 + Output format
   ```

3. **`src/agent/sub/filterIncompleteToolCalls.ts`**：S4——遍历父 messages 找出"有 tool_use 但无对应 tool_result" 的对，剔除整对。

4. **`src/agent/sub/contextInheritance.ts`**：组合 S5-S8：clone fileState、删 claudeMd（slim mode）、删 gitStatus（explore/plan）。

5. **`src/agent/sub/SubAgentSession.ts`**：

   ```ts
   export class SubAgentSession {
     constructor(opts: {
       parentSession: AgentSession;
       definition: SubagentDefinition;
       directive: string;
       maxDepth: number;
     });
     async run(): Promise<SubagentReport>;  // { markdown, usage }
   }
   ```

   内部：buildForkedMessages → filterIncompleteToolCalls → 构造受限 ToolRegistry → 构造 PromptAssembler（apply omitClaudeMd / omitGitStatus）→ 跑 `AgentLoop.run()` → 收 final assistant text → SubagentReport。

6. **重写 `src/tool/builtin/agent.ts`**：

   ```ts
   {
     name: "agent",
     input: { description, subagent_type, prompt, model? },
     async execute(input, context) {
       if (context.depth >= MAX_SUBAGENT_DEPTH) throw new ToolError("subagent_depth_exceeded");
       const def = SUBAGENT_TYPES[input.subagent_type];
       if (!def) throw new ToolError("invalid_request");
       const session = new SubAgentSession({ parentSession: context.session, definition: def, directive: input.prompt, ... });
       const report = await session.run();
       context.session.aggregateUsage(report.usage);
       return { result: report.markdown };
     }
   }
   ```

7. **`PolitDeckToolRuntimeContext.depth`**：必须传递 + +1 进 subagent。

8. **测试 + e2e**。

#### 6.2.6 行为对齐 checklist

- [ ] `subagent_type` 不在已知 set → `invalid_request`
- [ ] depth ≥ MAX → `subagent_depth_exceeded`（默认 1，禁递归）
- [ ] 父 assistant msg 完整保留（thinking + tool_use blocks + text）
- [ ] 每个 tool_use 都有对应 placeholder tool_result（恒定字符串）
- [ ] FORK_PLACEHOLDER_RESULT 在所有 fork 中字节相同（cache hit）
- [ ] explore / plan 子代理 system prompt 不含 claudeMd
- [ ] explore / plan 子代理 system context 不含 gitStatus
- [ ] explore / plan 子代理 isReadOnly = true，destructive tool 直接 deny
- [ ] subagent allowedTools 子集校验：调用未 allowed 的 tool → `tool_not_allowed`
- [ ] subagent 输出格式 `Scope:/Result:/Key files:/...` 5 字段
- [ ] subagent 内部 readFileState 跟父隔离
- [ ] subagent token usage 累加到父 session（不双重计算）
- [ ] subagent 内部不能再 fork（`agent` tool 在 subagent 里 throw）
- [ ] 中断父 → subagent 也中断（abortSignal 透传）
- [ ] subagent 输出末尾 `Scope: <echo>` 必有

#### 6.2.7 测试

```text
tests/agent/sub/build-forked-messages.test.ts   : S1-S3 完整对齐
tests/agent/sub/filter-incomplete.test.ts       : S4
tests/agent/sub/context-inheritance.test.ts     : S5-S8
tests/agent/sub/subagent-session.test.ts        : run() 主流程 + tool pool 限制
tests/tool/builtin-agent.test.ts                : agent tool e2e mock model
tests/agent/sub/depth-guard.test.ts             : 递归 fork 拒绝
tests/fixtures/agent/dual-parity/forked-messages.scenarios.ts (dual_parity)
tests/agent/e2e/real-subagent.test.ts (POLITDECK_RUN_REAL_SUBAGENT_E2E=1)
```

#### 6.2.8 工时与风险

- 实现：1.5 天
- 风险：父 transcript 进 subagent 的 PromptAssembler 路径要小心 — 不能让 subagent 看到自己之前的状态
- 风险：abortSignal 链式中断 → 父 abort 必须 cascading 到 subagent

#### 6.2.9 输出

- 5 个新文件 + 1 改动（agent.ts）+ 1 改动（runtime context.depth）
- 7 个测试 + 1 dual-parity scenarios + 1 e2e
- `politdeck-agent-refactor-development-guide.md` §X subagent 章节升级

---

### 6.3 C3 — Session sidechain transcript

#### 6.3.1 是啥（大白话）

C2 完成后，**子 agent 的对话也要写盘**到主 session 的子目录，主 transcript 留一条 reference（"see subagents/abc123.jsonl"）。这样以后 resume / inspect 能完整还原子 agent 行为。

#### 6.3.2 legacy 参考

| legacy 路径 | 行为 |
| --- | --- |
| `src/tools/AgentTool/agentMemorySnapshot.ts` | sidechain 写盘 schema：每个 subagent 独立 `<sessionId>-<subagentId>.jsonl` |
| `src/utils/sessionStorage.ts` `setAgentTranscriptSubdir(agentId, subdir)` | 分组路径到 `subagents/<runId>/` 子目录 |
| `src/tools/AgentTool/resumeAgent.ts` | resume 时按 subagentId 找 sidechain 并 replay |
| transcript entry types `subagent_started` / `subagent_completed` | 主 transcript 仅写 reference + summary |

**关键约束**：
1. 每个 subagent run 一个独立 sidechain 文件（不共享 file handle）。
2. 主 transcript 不写 subagent 的 turn-by-turn 内容（防爆炸）。
3. resume 时按 lazy load——默认不展开 sidechain，UI 主动点开才读。
4. 多 subagent 并发时 subagent ID 必须唯一（UUID v4）。

#### 6.3.3 当前 PolitDeck 骨架

- `src/session/storage/ProjectSessionStorage.ts`：已有 `toolResultsDir`，**无 `subagentsDir`**。
- `src/session/transcript/TranscriptEntry.ts`：未定义 sidechain 引用类型。
- `src/session/transcript/JsonlTranscriptWriter.ts`：单文件 writer，无 sidechain 派生。

#### 6.3.4 设计决策

| 决策 | 选择 |
| --- | --- |
| 路径 | `~/.politdeck/projects/<projectId>/sessions/<sessionId>/subagents/<subagentId>.jsonl` |
| 主 transcript 写啥 | `subagent_started` (subagentId, type, prompt 截断到 1 KB) + `subagent_completed` (subagentId, summary 截断到 4 KB, usage) 两条 |
| Sidechain 写啥 | 完整 turn-by-turn（user/assistant/tool）+ 起止 boundary entry |
| Writer 派生 | 父 writer 加 `forSubagent(subagentId, definition)` 返回独立 writer |
| Replay 支持 | `TranscriptReplay` 主 path 跳过 sidechain 内容；`replaySubagent(subagentId)` 显式入口 |
| Lazy load | 默认不读；UI / SDK consumer 主动调 `getSubagentTranscript(subagentId)` |
| 老 session 兼容 | 缺 sidechain 文件 → 视作"summary-only"，不抛错 |
| 唯一 ID | UUID v4 子 agent ID，碰撞概率 = 0 |
| 上限 | `maxSubagentTranscripts: 100`，超过自动归档老的（gzip 到 `archive/`） |

#### 6.3.5 实现步骤

1. **`src/session/storage/ProjectSessionStorage.ts`**：

   ```ts
   subagentsDir(sessionId: string): string {
     return path.join(this.sessionDir(sessionId), "subagents");
   }
   subagentTranscriptPath(sessionId: string, subagentId: string): string {
     return path.join(this.subagentsDir(sessionId), `${subagentId}.jsonl`);
   }
   ```

2. **`src/session/transcript/TranscriptEntry.ts`** 加 entry types：

   ```ts
   | { type: "subagent_started"; subagentId: string; subagentType: string; prompt: string; transcriptRelativePath: string; ... }
   | { type: "subagent_completed"; subagentId: string; summary: string; usage: AgentUsage; durationMs: number; ... }
   ```

3. **`src/session/transcript/JsonlTranscriptWriter.ts`**：

   ```ts
   forSubagent(subagentId: string, opts?: { type: string }): JsonlTranscriptWriter {
     const path = this.storage.subagentTranscriptPath(this.sessionId, subagentId);
     return new JsonlTranscriptWriter({ path, sessionId: this.sessionId, subagentId, ... });
   }
   ```

4. **`src/agent/sub/SubAgentSession.ts`**（与 C2 集成）：
   - 启动时调 parent transcript `recordSubagentStarted({ subagentId, type, prompt })`
   - 内部用 `parent.forSubagent(subagentId)` 写 sidechain
   - 完成时调 parent transcript `recordSubagentCompleted({ subagentId, summary, usage, durationMs })`

5. **`src/session/transcript/TranscriptReplay.ts`**：跳过 `subagent_*` 不展开（默认）。加 `replaySubagent(sessionId, subagentId): Promise<TranscriptEntry[]>` 显式入口。

6. **`src/session/storage/SessionList.ts`**：`getSession` 不加载 sidechain；`getSubagentTranscripts(sessionId)` 列出 subagentsDir 下所有文件。

7. **测试**。

#### 6.3.6 行为对齐 checklist

- [ ] sidechain 路径 `subagents/<subagentId>.jsonl`
- [ ] 主 transcript 仅 2 条 entry（started / completed）
- [ ] sidechain 含完整 turn 历史
- [ ] subagent ID UUID v4，并发不冲突
- [ ] resume 时主 transcript replay 不展开 sidechain
- [ ] 显式 `replaySubagent(...)` 能完整还原
- [ ] 缺 sidechain 文件不抛错（老 session 兼容）
- [ ] `subagent_completed.summary` 不超过 4 KB（防主 transcript 爆炸）
- [ ] usage aggregate 正确（subagent.usage 累加到 session.totalUsage）
- [ ] 超 100 个 subagent transcript → 老的归档到 `archive/<id>.jsonl.gz`

#### 6.3.7 测试

```text
tests/session/transcript/subagent-sidechain.test.ts
  : forSubagent 派生 / 主 transcript 2 条 entry / sidechain 完整

tests/session/transcript/replay-subagent.test.ts
  : 显式 replay subagent / 缺文件容忍

tests/agent/sub/subagent-transcript-integration.test.ts
  : C2 + C3 协同 e2e（fake model）

tests/session/transcript/subagent-archive.test.ts
  : 超 100 自动归档
```

#### 6.3.8 工时与风险

- 实现：半天
- 风险：并发 subagent 时 sidechain writer 文件句柄泄漏 → 必须 finally close
- 风险：summary 字段可能被 model 写得很长 → trim 到 4 KB

#### 6.3.9 输出

- 3 个新 entry types + 2 改动（writer / storage）+ 4 测试
- C2 联动：`SubAgentSession` 写 sidechain
- `politdeck-session-refactor-development-guide.md` §11 sidechain deferred → resolved

---

### 6.4 C4 — Session file-history / attribution restore

#### 6.4.1 是啥（大白话）

每次 `edit_file` / `write_file` 时**先把原文件 snapshot 一份**到 `~/.politdeck/projects/<id>/file-history/<sessionId>/`。session 结束后用户可以 `politdeck rewind <messageId>` 把所有文件状态回滚到那条消息；resume 时能告诉模型"这个文件在 session 中被你改过 3 次"。

#### 6.4.2 legacy 参考（必须保留的 14 个行为）

`third-party/claude-code-main/src/utils/fileHistory.ts` (1115 行)：

| 编号 | legacy export | 行 | 行为 |
| --- | --- | --- | --- |
| F1 | `fileHistoryTrackEdit(updateState, filePath, messageId)` | 86-193 | 编辑前调用：3-phase commit（check → backup → commit） |
| F2 | 重复 trackEdit 同 file 在同 snapshot 内 | 114-118 | **不重新备份**（防 v1 backup 被覆盖） |
| F3 | `createBackup(filePath, version)` | 748-798 | stat 先；ENOENT → null backup；copyFile 异步；preserve mode chmod |
| F4 | backup file name = `sha256(filePath).slice(0,16) + '@v' + version` | 725-731 | hash filePath 不 hash content（同 file 多版本） |
| F5 | resolveBackupPath = `<configDir>/file-history/<sessionId>/<backupFileName>` | 733-741 | session-scoped |
| F6 | `fileHistoryMakeSnapshot(updateState, messageId)` | 198-? | 创建新 snapshot；遍历 trackedFiles，mtime 改了就 v+1 backup |
| F7 | snapshots 是 array of `{ messageId, trackedFileBackups, timestamp }` | type | 主键 messageId |
| F8 | `fileHistoryRewind(updateState, messageId)` | 347-397 | findLast snapshot.messageId === messageId → applySnapshot |
| F9 | `applySnapshot` | - | 遍历 trackedFileBackups → restoreBackup（restoreBackup 也 lazy mkdir） |
| F10 | restoreBackup preserve mode | 819+ | chmod 还原 |
| F11 | null backup 表示"该 message 之前文件不存在" → restore = delete | F3 | rewind 时 unlink |
| F12 | `recordFileHistorySnapshot(messageId, snapshot, isUpdate)` | - | 写到 transcript（transcript 同时 record 历史） |
| F13 | LRU 上限：legacy 实际是按 trackedFiles count 控制（无显式 cap，靠 session 结束 cleanup） | - | PolitDeck 加 100 cap |
| F14 | `fileHistoryGetDiffStats(state, messageId)` | 414-? | 算 rewind 后 insertions/deletions（用 diff lib） |

**`attribution.ts`**（393 行）行级归因：每次 edit 记录 `(messageId, filePath, lineRange)` 映射。**legacy 这部分较复杂，本 PR 只做 file-level 归因（messageId → 是否改过此 file），暂不做 line-level**。

**关键边界条件**：
1. 文件**不存在**时（即将创建），backup = null backup（marker），rewind 时 unlink 还原"不存在"状态。
2. 文件存在但**第二次 edit 同 message 内**：不重复 backup（F2）。
3. 大文件（>10 MB）：legacy 不限，PolitDeck 加 cap，超大跳过 + warn。
4. 二进制文件：legacy 用 copyFile 不区分文本，PolitDeck 同样处理（任何 bytes 都备份）。
5. backup 路径不存在 → lazy mkdir + retry（性能）。

#### 6.4.3 当前 PolitDeck 骨架

- `src/tool/builtin/editFile.ts` / `writeFile.ts`：执行前**无 snapshot**。
- `src/session/`：无 file-history 子模块。

#### 6.4.4 设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| backup 命名 | `sha256(filePath).slice(0, 16) + '@v' + version` | 与 legacy 完全一致 |
| backup 路径 | `~/.politdeck/projects/<projectId>/file-history/<sessionId>/<name>` | 与 legacy 同（一份 sessionId scope） |
| State 数据结构 | `{ snapshots: Snapshot[]; trackedFiles: Set<string> }` | 与 legacy 同 |
| 持久化 | snapshot 同时写 transcript entry `file_snapshot_recorded`（F12）；进程重启从 transcript replay | 防进程崩溃丢 state |
| 文件大小上限 | 10 MB（超过跳过 + warn） | 防磁盘爆炸 |
| Line-level attribution | **本 PR 不做**（intentional_difference vs legacy） | 复杂度高，价值有限 |
| Snapshot 上限 | 100 snapshots / session（F13） | 防 unbounded growth |
| Rewind 命令 | `politdeck rewind <sessionId> <messageId>` + `--dry-run` | CLI |
| Diff stats | 必做（F14） | rewind 前显示影响 |
| 异步 vs 同步 | **全异步**（用 `node:fs/promises`） | 与 PolitDeck 既有风格一致 |
| 接入点 | `editFile.execute` / `writeFile.execute` 入口处 await `fileHistory.trackEdit(...)` | 不在 execute 后接（防丢） |

#### 6.4.5 实现步骤

1. **`src/session/filesystem/types.ts`**：

   ```ts
   export type FileHistoryBackup = { backupFileName: string | null; version: number; backupTime: Date };
   export type FileHistorySnapshot = {
     messageId: string;
     trackedFileBackups: Record<string, FileHistoryBackup>;
     timestamp: Date;
   };
   export type FileHistoryState = {
     snapshots: FileHistorySnapshot[];
     trackedFiles: Set<string>;
   };
   ```

2. **`src/session/filesystem/backupNaming.ts`**：完全对齐 F4：

   ```ts
   export function getBackupFileName(filePath: string, version: number): string {
     const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
     return `${hash}@v${version}`;
   }
   ```

3. **`src/session/filesystem/createBackup.ts`** 完全对齐 F3 + F10：stat 先、ENOENT 返 null backup、async copyFile、ENOENT lazy mkdir、preserve mode。

4. **`src/session/filesystem/restoreBackup.ts`**：null backup → unlink（F11）；非 null → copyFile + chmod。

5. **`src/session/filesystem/FileHistoryStore.ts`**：

   ```ts
   export class FileHistoryStore {
     constructor(opts: { sessionId; storage: ProjectSessionStorage; transcript: AgentTranscriptWriter; maxSnapshots: number; maxFileBytes: number });

     async trackEdit(filePath: string, messageId: string): Promise<void>;
     async makeSnapshot(messageId: string): Promise<void>;
     async rewind(messageId: string): Promise<{ filesChanged: string[] }>;
     async getDiffStats(messageId: string): Promise<{ filesChanged: number; insertions: number; deletions: number }>;
     getState(): FileHistoryState;
   }
   ```

   实装 F1-F2 3-phase commit；F8-F9 rewind；evict（state.snapshots.length > maxSnapshots → splice oldest，删 backup file）。

6. **`src/session/storage/ProjectSessionStorage.ts`** 加 `fileHistoryDir(sessionId)`。

7. **`src/session/transcript/TranscriptEntry.ts`** 加 `file_snapshot_recorded`：

   ```ts
   { type: "file_snapshot_recorded"; messageId: string; trackedFiles: string[]; isSnapshotUpdate: boolean; ... }
   ```

8. **`src/tool/builtin/editFile.ts` / `writeFile.ts`**：在 `execute` 入口处：

   ```ts
   await context.fileHistory?.trackEdit(input.filePath, context.messageId);
   ```

9. **`src/agent/loop/AgentLoop.ts`**：每 user turn 入口调 `fileHistory.makeSnapshot(messageId)`。

10. **`src/cli/commands/rewind.ts`**：

    ```bash
    politdeck rewind <sessionId> <messageId> [--dry-run]
    ```

    实装：load FileHistoryStore from session → getDiffStats → 显示 → 用户确认 → rewind。

11. **`src/session/storage/SessionResumer.ts`**：从 transcript `file_snapshot_recorded` entries replay 出 state。

12. **测试 + e2e**。

#### 6.4.6 行为对齐 checklist

- [ ] 同 message 重复 trackEdit 同 file → 不重复 backup（F2）
- [ ] backup 文件名 = `sha256(filePath).slice(0,16) + '@v' + version`
- [ ] 文件不存在 trackEdit → null backup
- [ ] rewind null backup → unlink 文件
- [ ] backup file mode preserve（chmod）
- [ ] >10 MB 文件跳过 + warn
- [ ] 100 snapshots cap，超过自动 evict 最老的
- [ ] evict 时同步删 backup 文件（不留孤儿）
- [ ] rewind 跳过缺失 backup（F13 兼容）
- [ ] makeSnapshot 时 mtime 没变的 trackedFile 不 re-backup
- [ ] makeSnapshot 时 mtime 变了 → version + 1
- [ ] 进程崩溃后 transcript replay 能还原 state
- [ ] CLI rewind --dry-run 显示影响但不修改
- [ ] CLI rewind 不在 sessionDir 找不到 → 友好错误

#### 6.4.7 测试

```text
tests/session/filesystem/backup-naming.test.ts
tests/session/filesystem/create-backup.test.ts        : ENOENT / mkdir lazy / chmod preserve
tests/session/filesystem/restore-backup.test.ts       : null backup → unlink / 文件 mode 还原
tests/session/filesystem/store-track-edit.test.ts     : F1 + F2
tests/session/filesystem/store-make-snapshot.test.ts  : F6 mtime 检测
tests/session/filesystem/store-rewind.test.ts         : F8 + F9 + F11
tests/session/filesystem/store-evict.test.ts          : 100 cap + 文件 cleanup
tests/cli/rewind.test.ts                              : --dry-run + apply
tests/session/filesystem/replay-from-transcript.test  : 进程崩溃后 state 还原
```

#### 6.4.8 工时与风险

- 实现：1.5 天（state machine + 3-phase commit + rewind + CLI）
- 风险：3-phase commit 在并发场景下需要细心写——多个 trackEdit 同时进 phase 1 可能产生 race；用 mutex 串行
- 风险：transcript replay 时 backup 文件被人手动删过 → rewind 失败要 graceful warn

#### 6.4.9 输出

- 6 个新文件 + 3 改动（editFile / writeFile / AgentLoop）+ 1 CLI 命令
- 9 个测试
- `politdeck-session-refactor-development-guide.md` §11 file-history deferred → resolved（attribution line-level 仍 partial）

---

### 6.5 C5 — Background task runtime

#### 6.5.1 是啥（大白话）

让 `bash` 工具能跑一个**几小时不结束的命令**（比如训练 / 部署），主对话不阻塞，可以查询 / 停止 / 看输出。

#### 6.5.2 legacy 参考（必须保留的 11 个行为）

`third-party/claude-code-main/src/tasks/`：

| 编号 | 文件 | 行为 |
| --- | --- | --- |
| T1 | `types.ts` | `TaskState` 联合：`{ type: "local_bash"\|"local_agent"\|... }`；多种 task 类型共用基类 |
| T2 | `LocalShellTask/guards.ts` | `isLocalShellTask(task)` discriminator |
| T3 | `LocalShellTask/LocalShellTask.tsx` `LocalShellTaskState` | `{ command, result?: { code; interrupted }, completionStatusSentInAttachment, shellCommand, unregisterCleanup, cleanupTimeoutId, lastReportedTotalLines, isBackgrounded, agentId?, kind: 'bash'\|'monitor' }` |
| T4 | `agentId` 字段 | task 关联 spawning agent；agent 退出时 `killShellTasksForAgent(agentId)` |
| T5 | `kind: 'monitor'` | UI 显示变体（status bar pill） |
| T6 | `completionStatusSentInAttachment` | 防重复发送 completion attachment 给 model |
| T7 | `lastReportedTotalLines` | 增量 output 计算 |
| T8 | `isBackgrounded: false → true` | foreground 切到 background 时显式更新 |
| T9 | tools: `TaskCreateTool` / `TaskGetTool` / `TaskOutputTool` / `TaskStopTool` | 4 个 task 工具 |
| T10 | session 结束 → kill all tasks | killShellTasks.ts + sessionEnd hook |
| T11 | output 大小管理 | TaskOutput 类聚合 stdout/stderr |

**legacy "task" 概念抽象**：not just bash，涵盖 local_agent（C2 异步版）、in_process_teammate（多智能体协作）、remote。本 PR **只实装 bash 子集**。

#### 6.5.3 当前 PolitDeck 骨架

- `src/tool/builtin/bash/commandRunner.ts`：所有 bash 同步等结果。
- 无 `src/task/`。

#### 6.5.4 设计决策

| 决策 | 选择 |
| --- | --- |
| 模块路径 | `src/task/` |
| 本轮范围 | **只 bash background task** |
| Local agent task | C2 落地后再补（同步阻塞 C2 不需要这个） |
| Remote task | D 类，**不做** |
| State 字段 | 完全对齐 T3 LocalShellTaskState |
| `agentId` | 必做（T4） — session 结束 / agent 退出时清理 |
| `kind` | 必做（T5） — `bash` / `monitor`（monitor 是长期运行 + 周期轮询 status 的变体） |
| Output buffer | 内存 1 MB 循环 buffer + 磁盘 spill |
| Output 增量读 | `task_output(taskId, offset)` 返回新增部分（T7） |
| Tools | 4 个：`task_create`(start) / `task_list` / `task_output` / `task_stop` |
| `bash` 工具集成 | 加 `mode: "foreground"\|"background"`；background 模式立刻返回 `{ taskId, status: "running" }` |
| Process kill | SIGTERM → 5s grace → SIGKILL（与 PolitDeck `bashCommandRunner` 已有逻辑一致） |
| OS 兼容 | macOS / Linux only；Windows 文档标 not supported |
| 平台特殊 | 子进程 `detached: true` + `unref()` 让 PolitDeck 进程退出不阻塞 |
| Cleanup hook | `SessionRouter.onSessionEnd(...)` 串行 SIGTERM all tasks |

**Task state schema**（对齐 T3）：

```ts
export type PolitDeckBackgroundBashTask = {
  taskId: string;
  type: "local_bash";
  agentId?: string;             // T4
  kind: "bash" | "monitor";     // T5
  command: string;
  cwd: string;
  pid?: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  exitCode?: number;
  interrupted: boolean;
  isBackgrounded: boolean;
  completionStatusSentInAttachment: boolean;  // T6
  lastReportedTotalLines: number;             // T7
  startedAt: Date;
  endedAt?: Date;
  outputCacheBytes: number;
};
```

#### 6.5.5 实现步骤

1. **`src/task/protocol/types.ts`**：上面 schema + status enum。

2. **`src/task/storage/TaskOutputStore.ts`**：

   ```ts
   export class TaskOutputStore {
     constructor(opts: { taskId; storage: ProjectSessionStorage; maxMemoryBytes: 1_000_000 });
     append(chunk: Buffer): void;
     readSlice(offset: number, maxBytes?: number): { content: string; nextOffset: number; truncated: boolean };
     totalBytes(): number;
     close(): void;
   }
   ```

   实装：内存 ring buffer 1 MB；超出 spill 到 `~/.politdeck/projects/<id>/sessions/<sid>/tasks/<taskId>/output.log`；`readSlice` 必要时从磁盘读。

3. **`src/task/runtime/BackgroundTaskRuntime.ts`**：

   ```ts
   export class BackgroundTaskRuntime {
     constructor(opts: { storage, sessionRouter });

     async start(spec: { command, cwd, env?, agentId?, kind?: "bash"|"monitor" }): Promise<PolitDeckBackgroundBashTask>;
     async stop(taskId: string, opts?: { graceMs?: number }): Promise<void>;
     async list(filter?: { agentId?, status? }): Promise<PolitDeckBackgroundBashTask[]>;
     async getOutput(taskId: string, offset: number): Promise<TaskOutputSlice>;
     killForAgent(agentId: string): Promise<void>;       // T4 + T10
     killAll(): Promise<void>;
   }
   ```

   `start`：`spawn(command, { shell: true, detached: true, cwd, env })`；child.stdout/stderr 喂 TaskOutputStore；`unref()`；监听 `exit` 更新 status。

4. **`src/tool/builtin/taskCreate.ts`**：
   - input `{ command, kind?, agentId? }`
   - execute → `runtime.start(...)` 返回 `{ taskId, status: "running" }`
   - shouldDefer: false（立刻返回）

5. **`src/tool/builtin/taskList.ts`** / **`taskOutput.ts`** / **`taskStop.ts`**：薄包装。

6. **`src/tool/builtin/bash.ts`** 加 `mode: "foreground" | "background"`：
   - foreground 走原 commandRunner
   - background 走 `runtime.start(...)`

7. **`src/session/SessionRouter.ts`**——加 hook 时与 cron owner 同步，避免重复实装：

   **现状（cron owner 2026-05-09 确认）**：当前 SessionRouter **没有**独立 `onSessionEnd` option，现有的 SessionEnd 走的是 `AgentSession` 自身 lifecycle dispatch。本 PR 要新增一个 router-level hook 接口：

   ```ts
   export interface SessionRouterEndHook {
     readonly id: string;          // 唯一 ID，调试用
     readonly priority: number;    // 数字小的先执行
     readonly onSessionEnd: (sessionKey: string) => Promise<void>;
   }
   SessionRouter.registerEndHook(hook: SessionRouterEndHook): () => void;
   ```

   **本 PR 注册**（priority 保留区间 `[200, 299]` 给本文 C5）：

   ```ts
   sessionRouter.registerEndHook({
     id: "task-runtime-cleanup",
     priority: 200,
     onSessionEnd: async () => runtime.killAll(),
   });
   sessionRouter.registerEndHook({
     id: "task-runtime-agent-cleanup",
     priority: 210,
     onSessionEnd: async () => { /* per-agent killForAgent loop, called via onAgentEnd separately */ },
   });
   ```

   **Cron PR 的占位**（同事已确认会用）：

   ```ts
   // cron owner：priority [100, 199]——必须先于 C5 跑
   //   100 = cron_schedule_next_trigger      （持久化下一次触发时间，必须先做）
   //   110 = cron_release_session_lease       （释放 daemon 端 session lease）
   ```

   **Hook 顺序约定**（双方共识）：

   1. **Cron 先**（priority 100-199）：`schedule_next_trigger` + `release_session_lease`——必须在 task cleanup 之前持久化下一次触发，否则 cron 语义会被破坏。
   2. **C5 后**（priority 200-299）：`killAll` 把 session 内未结束 task SIGTERM。
   3. priority 区间互不重叠（cron 100-199 / C5 200-299 / 其他模块未来 300+）；本 PR 只注册 200-299，不动 100-199。
   4. cron 注册的 hook 通过 daemon process 内的 SessionRouter 实例（不是本 PR 的 session-process 实例）；如果未来发现要跨进程同步，再开 RFC（§7 D 类）。

8. **测试 + e2e**。

#### 6.5.6 行为对齐 checklist

- [ ] task_create → 立即返 `{ taskId, status: "running" }`，不阻塞
- [ ] 子进程 detached + unref（PolitDeck 退出不阻塞）
- [ ] task_output 增量返回（lastOffset → newOffset）
- [ ] output 1 MB 内存上限，超出 spill 磁盘
- [ ] task_stop → SIGTERM → 5s grace → SIGKILL
- [ ] task_stop 已结束 task → 幂等（status 不变）
- [ ] session 结束 → killAll() 同步调用
- [ ] agentId 关联：agent 退出 → killForAgent
- [ ] kind = "monitor" task 可被 task_list 过滤
- [ ] 进程 zombie：spawn 后必有对应 exit 监听 + state 更新
- [ ] taskId UUID v4
- [ ] SIGTERM 触发 `interrupted: true` 标记
- [ ] OS = Windows → start 抛 `unsupported_platform`

#### 6.5.7 测试

```text
tests/task/protocol-types.test.ts
tests/task/storage/output-store.test.ts        : ring buffer / disk spill / read slice
tests/task/runtime/start-and-monitor.test.ts   : sleep 1 → status running → wait → completed
tests/task/runtime/stop.test.ts                : SIGTERM → grace → SIGKILL
tests/task/runtime/kill-all.test.ts            : sessionEnd 清理
tests/task/runtime/kill-for-agent.test.ts      : T4 + T10
tests/tool/builtin-task-create.test.ts
tests/tool/builtin-task-output-stop.test.ts
tests/tool/builtin-bash-background.test.ts     : mode=background 路径
tests/agent/e2e/real-bg-task.test.ts           : POLITDECK_RUN_REAL_BG_TASK_E2E=1
```

#### 6.5.8 工时与风险

- 实现：1.5 天
- 风险：子进程僵尸（unref 后 OS 不报 exit 给 parent；必须显式 listen 'exit'）
- 风险：Windows 上 detached 行为差异；本轮直接 unsupported
- 风险：与 cron PR 的 SessionRouter hook 顺序冲突 → 已与 owner 对齐 priority 区间（cron 100-199 / C5 200-299）+ hook id 命名约定

#### 6.5.9 输出

- 6 个新文件（types / runtime / store / 4 tools）+ 1 改动（bash.ts）+ 1 hook（SessionRouter）
- 10 个测试 + 1 e2e
- `politdeck-tool-refactor-development-guide.md` §13.X task_* 章节升级

---

## 7. Tier D — 决策类（暂不实施 / 先 RFC 后实现）

> **状态（2026-05-09）**：本轮**整体跳过**。等远端连接需求、企业 SaaS 方向、部署形态定下来后再开 RFC + 实施。本节保留作为决策时的参考素材。

每条都先用 RFC 决定方向再写代码。本节给出决策点 + 接入点，**不给完整步骤**。

### 7.1 D1 — Session remote / activity heartbeat

**决策点**：

- 远端连接是否真的需要？现状：所有 adapter 都本地，Gateway 是 localhost-only。
- 如果做：用 long-poll / SSE / WebSocket？
- lease 时长 / heartbeat 频率？

**接入点**：

- `src/gateway/server/GatewayServer.ts`：加 activity tracker。
- `src/session/SessionRouter.ts`：加 `onClientHeartbeat`。

**legacy 参考**：

- `third-party/claude-code-main/src/utils/activityManager.ts`。
- `third-party/claude-code-main/src/utils/background/remote/remoteSession.ts`。

**工时（决策后）**：半天。

### 7.2 D2 — Feishu OAuth

**决策点**：

- 当前 Feishu webhook + token 已经能跑；OAuth 是企业级合规需求，是否 launch 客户必须？
- 走 SSO 还是 app-level？

**接入点**：

- `src/adapters/channel/feishu/FeishuChannel.ts`：替换 token 获取链路。

**工时（决策后）**：1 天。

### 7.3 D3 — Gateway TLS

**决策点**：

- 远端连接定下来后才有意义；本地 unix socket 不需要 TLS。
- 自签证书 / mkcert / cloudflared tunnel？

**接入点**：

- `src/gateway/server/GatewayServer.ts`：当前 `createServer`，要改为 `createSecureServer`。

**工时（决策后）**：半天。

### 7.4 D4 — Feishu multi-device

**决策点**：

- 同一用户多个设备（手机 + 电脑 + iPad）能否共享 session？
- 推送通知策略？

**接入点**：

- `src/adapters/channel/feishu/FeishuSessionMapper.ts`：当前 user → session 1:1，需要支持 1:N device 同 session。

**工时（决策后）**：1 天。

### 7.5 D5 — Gateway rate limit

**决策点**：

- 部署后再决定 per-user / per-IP / per-channel；本地单用户不需要。

**接入点**：

- `src/gateway/server/GatewayServer.ts`：加 token bucket 中间件。

**工时（决策后）**：半天。

---

## 8. 横切关注点

### 8.1 测试策略

#### 8.1.1 必做测试

每个 Tier A/B/C feature 都必须有：

- **unit test**：所有分支覆盖，mock IO / 子进程。
- **行为对齐 checklist**：每条 feature 的 §X.X.6 列出来的"行为对齐 checklist"必须**100% pass**——这是与 legacy 行为最细粒度对齐的"硬指标"。PR 描述里勾选每一条，未对齐的必须显式标 `intentional_difference` 加理由。
- **dual-parity test**（如果 legacy 有同等实现）：放 `tests/fixtures/<module>/dual-parity/<feature>.scenarios.ts`，主 PR 走 PolitDeck 路径，legacy 路径作 reference assertion。每个 scenario 显式带 `parityStatus: "dual_parity" | "intentional_difference"`。
- **e2e test**（标 `POLITDECK_RUN_REAL_*_E2E=1`）：至少 P0 / P1 必须有。

#### 8.1.2 dual-parity 表

| Feature | 是否有 legacy 等价物 | parityStatus | 备注 |
| --- | --- | --- | --- |
| A1 worktree lookup | ✅ `findCanonicalGitRoot` (git.ts) | `dual_parity` | filesystem-only async 实现，安全验证完全对齐；non-git fallback 是 intentional |
| A2 tokenizer fallback | ✅ `roughTokenCountEstimation*` 全套 | `dual_parity` | 9 种 block 类型 + 4/3 padding + image/PDF=2000 |
| A3 structured_output | ❌ legacy 用 forced tool_use 间接做 | `intentional_difference` | PolitDeck 走 provider native (`response_format`) |
| A4 cached microcompact | ✅ `microCompact.ts` 接口；cachedMicrocompact 未收录 | `intentional_difference` | 简化版，只 pending 不 pinned LRU |
| A5 snip compact | ✅ `getMessagesAfterCompactBoundary({ includeSnipped })` + `projectSnippedView` | `dual_parity`（projection 路径）+ `intentional_difference`（触发模式） | legacy 是 model 端 SnipTool；PolitDeck 是 auto policy |
| B1 elicitation | ✅ `AskUserQuestionTool.tsx` 完整 schema | `dual_parity` | schema / 输出格式 / shouldDefer / HTML 校验完全对齐 |
| B2 web_fetch | ✅ `WebFetchTool/utils.ts` + `preapproved.ts` | `dual_parity`（13 安全行为 + 167 域名）+ `intentional_difference`（不走 Anthropic domain blocklist API） | preapproved 完整移植 |
| B3 mcp instructions read-only | ⚠️ 静态子集（legacy 是运行时） | `intentional_difference` | C1 后升级到 runtime |
| C1 mcp runtime | ✅ `services/mcp/client.ts` 16 行为 | `dual_parity`（核心 connect/list/call/wire-name/截断）+ `intentional_difference`（OAuth / SSE / WebSocket 不实装） | 引 `@modelcontextprotocol/sdk` |
| C2 subagent fork full | ✅ `forkSubagent.ts` + `runAgent.ts` 12 行为 | `dual_parity` | buildForkedMessages / FORK_PLACEHOLDER_RESULT / 3 builtin types 完全对齐 |
| C3 sidechain | ✅ `agentMemorySnapshot.ts` + `setAgentTranscriptSubdir` | `dual_parity` | 文件 layout 与 legacy 可不同（projectId 前缀），但 entry types 行为对齐 |
| C4 file history | ✅ `fileHistory.ts` 14 行为 | `dual_parity`（backup 命名 / 3-phase commit / null backup / chmod / mtime 检测） | line-level attribution 仍 partial |
| C5 background task | ✅ `tasks/LocalShellTask` 11 行为 | `dual_parity`（state schema + agentId + kind + completionStatusSent）+ `intentional_difference`（仅 bash，不做 LocalAgentTask / Remote） | |

#### 8.1.3 e2e test naming

- 真实 API：`POLITDECK_RUN_REAL_<module>_E2E=1` 才跑。
- 长时间 task：`POLITDECK_RUN_LONG_E2E=1`。
- 默认 CI 不跑 e2e，需要本地手动 trigger。

### 8.2 Owner 划分建议

| Tier | Feature | 主 owner | 协评 |
| --- | --- | --- | --- |
| A | A1 worktree | session | — |
| A | A2 tokenizer | context | model |
| A | A3 structured output | tool + model | agent |
| A | A4 cached MC | context | model（Anthropic provider） |
| A | A5 snip | context | session |
| B | B1 elicitation | adapter | tool + **gateway / cron owner**（确认 Gateway 协议 `elicitation_*` 命名空间） |
| B | B2 web_fetch | tool | context（secondary model 用 model client） |
| B | B3 mcp instructions read-only | context + extension | tool |
| C | C1 mcp runtime | mcp（新 owner？或 tool owner 兼任） | extension |
| C | C2 subagent fork | agent | tool |
| C | C3 sidechain | session | agent |
| C | C4 file history | session | tool |
| C | C5 bg task | tool | session（SessionRouter hook） + **cron owner**（priority 区间约定） |
| — | cron_* tools / scheduler | cron PR owner（同事，本文不实施） | 本文 owner（确认命名空间 + hook 顺序不冲突） |
| D | all | 各自 | 产品决策先 |

#### 8.2.1 与 cron PR 的协调点（2026-05-09 已对齐）

| 协调维度 | 本文承诺 | cron owner 承诺 |
| --- | --- | --- |
| Gateway 命名空间 | 仅占用 `elicitation_*`（B1） + `task_*`（C5） | 仅占用 `cron_*`；不引入 `elicitation_*` / `task_*` |
| Tool registry 名 | 仅注册 `task_*`（C5）/ `web_fetch`（B2）/ `ask_user_question`（B1）/ `mcp__*`（C1）/ `agent`（C2 重写） | 仅注册 `cron_*`；不占用 `task_*` / `memory_*` / `skill_*` / `web_fetch` / `ask_user_question` |
| CLI 子命令 | 仅 `politdeck rewind`（C4） | 仅 `politdeck cron *`；不占用 `rewind` |
| SessionRouter hook priority | 200-299（C5） | 100-199（cron 自身 schedule + lease） |
| PolitConfig 顶层节点 | 不创建顶层新节点（仅在 `context.*` / `tool.*` 已有节点扩展） | 创建独立 `cron?: CronConfig` 顶层节点 |
| Process model | session-process scope（C5 runtime 在 session 主进程内） | daemon-process scope（cron scheduler 在 daemon 进程） |
| Submitting turn | 不接 cron submitTurn 路径 | cron run 触发后用 gateway `submitTurn` 绑定原 sessionKey/channelKey/projectKey |
| 共享 task tracker | 第一版 **不抽**（C5 独立 `task_*` store） | 第一版 **不抽**（cron 独立 `cron_*` store） |
| 共享 task tracker 升级 | 如果 D 类 / cron 任一方需要跨进程 tracker，再开 RFC 抽 `src/task/protocol/`（中立位置） | 同上 |

### 8.3 落地顺序（2026-05-09 确定）

执行模式：**wave-by-wave 串行**，每个 Wave 完成后必须跑 `npm test` + 对应 e2e + 文档同步 + commit，再进入下一 Wave。

```text
Wave 1（5 项 A 类，纯本仓无新依赖）：
  A1 worktree lookup        → 5-6h（含完整 legacy 安全验证 + dual-parity）
  A2 real tokenizer         → 5h（含 9 种 block 类型 + 4/3 padding + dual-parity）
  A3 structured_output      → 4h（OpenAI + Anthropic forced tool 路径）
  A4 cached microcompact    → 4-5h（Anthropic-only + COMPACTABLE_TOOLS 集合）
  A5 snip compact           → 半天（含 tool pair 完整性 + projection + dual-parity）
  小计 ~3 天

Wave 2（3 项 B 类）：
  B1 elicitation + ask_user_question → 1.5 天（schema 完全对齐 legacy + 3 channel impl）
  B2 web_fetch 完整版                → 1 天（13 个安全行为 + 167 域名预审 list）
  B3 MCP instructions read-only      → 半天（含 2048 截断 + ext API for C1 升级）
  小计 ~3 天

Wave 3（3 项 C 类，无依赖前置）：
  C4 file-history             → 1.5 天（3-phase commit + rewind CLI + 14 行为对齐）
  C5 background task runtime  → 1.5 天（11 行为对齐；与 cron PR SessionRouter hook 协调）
  C1 MCP runtime              → 1.5-2 天（引 @modelcontextprotocol/sdk + 16 行为对齐 + 2 transport）
  小计 ~5 天

Wave 4（2 项 C 类，紧密依赖）：
  C2 subagent fork full → 1.5 天（12 行为对齐 + 3 builtin types + dual-parity forked-messages）
  C3 sidechain          → 半天（紧跟 C2 + lazy load + 100 cap）
  小计 ~2 天

合计：~13 天纯编码 + review/debug/合并冲突 buffer ≈ 3-4 周。

Wave 5（决策类，暂不开始）：D1-D5 等产品方向决策。
```

每个 Wave 内部的具体顺序：

- **Wave 1**：A1 / A2 / A3 / A5 任意顺序（无相互依赖）；A4 放最后（依赖 Anthropic provider owner 同步）。
- **Wave 2**：B3（无依赖）→ B2（引依赖）→ B1（cron Gateway 协议命名空间已 2026-05-09 确认，不再 block；可与 cron PR 并行 PR）。
- **Wave 3**：C4（最独立）→ C5（cron SessionRouter hook priority 区间已 2026-05-09 确认 200-299；可与 cron PR 并行 PR）→ C1（最大改动）。
- **Wave 4**：C2 → C3（C3 必须紧跟 C2）。

#### 8.3.1 与 cron PR 的并行执行说明

cron owner 2026-05-09 确认所有协调点（见 §8.2.1）。本文 13 项 feature **可与 cron PR 并行 PR**，无需相互等待，因为：

1. Gateway 协议层 `elicitation_*` / `task_*` 与 `cron_*` 命名空间互不重叠 → 同一文件可分别 PR 加方法。
2. SessionRouter hook priority `[100,199]` (cron) vs `[200,299]` (本文 C5) → 同一文件可分别 PR 加 hook。
3. CLI 子命令 `cron *` vs `rewind` → 完全独立。
4. PolitConfig：cron owner 加顶层 `cron?` 节；本文不动顶层结构。
5. Tool registry：完全独立的工具名集合。

合并冲突预期最小（仅 `src/gateway/protocol/types.ts` 和 `src/session/SessionRouter.ts` 两个文件可能同时被改）；遇冲突时按 §8.2.1 protocol union 顺序合并即可。

### 8.4 验收清单

每个 feature PR 必须达到：

- [ ] 命名全部 `politdeck_*` / `PolitDeck*`，无 legacy brand 名泄漏。
- [ ] unit test 覆盖所有分支（包括 error 路径）。
- [ ] 如果有 legacy 等价物，对应 dual-parity scenario 已加并标 `parityStatus`。
- [ ] P0 / P1 至少一个 real-API e2e。
- [ ] 对应模块的 development guide / test maintenance guide 已同步（"实施进度"表 + "deferred" 列表）。
- [ ] 不引未在 §依赖 列声明的 npm 包。
- [ ] 不动其他 owner 公共协议（除非显式声明并 cc owner）。
- [ ] `npm run typecheck` + `npm test` 通过。
- [ ] CHANGELOG / git commit message 关联到本文 feature ID（A1 / B2 / C3...）。

### 8.5 RFC 模板（D 类用）

```markdown
# RFC: <D 类 feature 名>

## 背景
<为什么现在讨论>

## 决策点
1. <选项 A> vs <选项 B>，差异是 X / Y / Z。
2. ...

## 推荐方案
<选 A / B 及理由>

## 接入点
- 文件: ...
- 接口: ...

## 工时
- 实现: X
- 测试: Y

## 风险
- ...

## 决策状态
[ ] open / [ ] accepted / [ ] rejected
决策日期：YYYY-MM-DD
```

D 类 feature 必须先有一个 accepted 的 RFC 才能写代码。

---

## 9. Quick reference — 常见疑问

### Q1：`A3 structured_output` 跟 `T1` `tool model client`（已完成）有什么区别？

- T1：tool 内可以调 model（用于 web_fetch secondary、agent subagent etc.）。属于 tool runtime 内部能力。
- A3：让主 agent 调用 model 时强制输出 schema。属于 model 协议公开扩展。两者不重叠。

### Q2：`C2 subagent fork` 和现有 `agent` 工具 P0 区别？

- P0：单次 model.complete + return text。子代理"想一次说一段"。
- C2：递归 AgentLoop。子代理可以多 turn、调工具、自己 compact。

### Q3：`C3 sidechain` 能不能不依赖 `C2`？

- 不能。没有完整子 loop 就没有"子代理 transcript"。但 `C3` 的接口可以**先定义**让 `C2` 一起 review。

### Q4：`B3 mcp instructions read-only` 和 `C1 mcp runtime` 关系？

- B3 是从 manifest 静态读取 instructions 字段；不需要真实 connect。
- C1 完成后，运行时获取的 instructions 应该 override 静态值；B3 的接口 `getMcpInstructions()` 保持不变，实现内部切换数据源。

### Q5：`C5 background task` 为什么不和 `C2 subagent` 一起做？

- 都做太大，单 PR review 困难。C5 解决 shell；C2 解决 agent；两者公共抽象 `BackgroundTaskRuntime` 的 task type 已经在 §6.5.4 定义，C2 落地时只需要扩展一个新 task type（`local_agent_task`）。

### Q6：所有这些做完，PolitDeck 是不是就跟 Claude Code 完全一样了？

- 不是。还差：
  - LSP integration（lsp tools，独立 owner）。
  - Coordinator mode（产品功能，未确定）。
  - Workflow / Sleep / Brief 等 ant-only feature（不接，product 不做）。
  - UI 渲染层（PolitDeck 用 Ink + dark blue 主题，已 diverge）。

完整 feature gap 见 `politdeck-tool-refactor-development-guide.md` §1.6.3 + §3.1。

---

## 10. 关联文档

- `docs/rewrite-plan/02-rewrite-project-report.md`：总架构。
- `docs/politdeck-agent-refactor-development-guide.md`：agent 模块（C2 主要扩展点）。
- `docs/politdeck-context-refactor-development-guide.md`：context 模块（A2 / A4 / A5 / B3 主要扩展点）。
- `docs/politdeck-session-refactor-development-guide.md`：session 模块（A1 / C3 / C4 主要扩展点）。
- `docs/politdeck-tool-refactor-development-guide.md`：tool 模块（A3 / B1 / B2 / C5 主要扩展点）。
- `docs/politdeck-adapter-refactor-development-guide.md`：adapter 模块（B1 / D2 / D4 主要扩展点）。
- `docs/politdeck-agent-test-maintenance-guide.md`：agent 测试 / parity 列表。
- `docs/politdeck-tool-test-maintenance-guide.md`：tool 测试 / parity 列表。
- `.cursor/skills/refactor-with-parity/SKILL.md`：refactor with parity skill 主文档。

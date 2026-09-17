# Agent Note: ui/server 登记项的载体重建与死表面退役

Status: implemented

## Problem

2026-08 的代码精炼审计（C34，2026-09-06）在 `ui/server` 登记了一批缺陷与死代码，但只落在
**快照文档**里（`docs/code-refinement-plan.md:158,563-578`、`docs/code-refinement-report.md:82`）：

- **P0 级候选 9 项**（chat.js 广播缺失、shell.js PTY 竞态 ×2、sati-bridge Map 慢泄漏、
  taskmaster MCP 死链路、`/load` 路径校验、git `/status` 丢 R/C、agent.js 四项、`/test-connection`）；
- **死路由 9 条**（taskmaster 8 条 + `/api/commands/load`）；
- **退役建议 2 项**（`utils/globalChrome.js`、`services/always-on-paths.js`）。

这两份文档**已退出事实源地位**（`code-refinement-plan.md:717` 声明改由 `backlog.md` +
`metrics.md` 维护），于是这批条目既不在看板上、也不被 stale 治理、也没有认领入口——
从治理角度看它们**不存在**。issue #356 的诉求就是把它们带回可跟踪状态。

## Decision

分两步：**先逐条复核（把不成立的销项、把机制讲错的改正）**，**再按域落地**。

### 1. 逐条复核（2026-09-17，锚点定位而非按登记行号）

| # | 登记项 | 裁定 | 核码证据 |
|---|---|---|---|
| 1 | chat.js edit / regen 流**不广播** | **仍成立** | `chat.js:397-402` / `417-422` 把 gateway 流交给 `writer`（只回 `this.ws`），而 `sati-command` 走 `streamWriter`（`:351`）。`broadcastRewriteOptimisticFrames`（乐观行 + `Processing`）**广播**给兄弟 watcher，回答流**不广播** ⇒ 兄弟标签页停在 `Processing`。两处同在 `1014a694d`（PR #245）内 → 遗漏而非省流 |
| 2 | shell.js PTY **重连竞态** | **仍成立** | 重连分支设 `existingSession.ws = ws`（`shell.js:153`）；旧连接的 `close` 处理器取**同一 map 条目**并 `session.ws = null` + 挂 30 分钟 kill 定时器（`:447-465`）⇒ 新连接收不到输出、正在用的会话 30 分钟后被 kill |
| 3 | shell.js `onExit` **误删同 key 新会话** | **仍成立** | 会话身份放在可变闭包变量 `ptySessionKey`（`:86`，`:114` 每次 `init` 重写），`onExit` 读它并 `ptySessionsMap.delete`（`:404`），**未比对实例**。`onData`（`:322-323`）同理 ⇒ 旧 PTY 的输出会写进新会话的 ws 与 buffer（跨会话串流） |
| 4 | sati-bridge **Map 慢泄漏** | **仍成立**（严重级低） | `sessionState` 仅会话**被删除**时清退（`:299`）；`subagentActivityStarts` 仅终态清退（`:531`）；`pendingAgentToolCalls` 仅在对应 `subagent_started` 到达时清退（`:538-552`）。三处清退都挂在「对端一定发终态事件」上，而中断 turn / gateway 重启恰是该假设不成立时 |
| 5 | taskmaster **MCP 状态死链路** | **仍成立**（两侧都死） | `taskmaster-mcp-status-changed` **全仓零生产者**（`broadcastMCPStatusChange` 在 C34 已删，且删前也从未被调用）；前端监听在 `TaskMasterContext.tsx:230`（#356 退役时删除） |
| 6 | `/load` **路径校验弱于 `/execute`** | **已修 → 销项** | `2026-09-15` 的 #365 已让两条路由共用 `commandPaths.js:resolveCommandPath()`（`commands.js:965-974`），并由新文件 `ui/server/utils/commandPaths.test.js`（14 例）钉住策略。**登记已过时** |
| 7 | git `/status` **丢 rename/copy** | **仍成立** | `git.js:326-341` 只认 `M`/`A`/`D`/`??`；同文件 `parseStatusFilePaths`（`:231-242`）**已**处理 `" -> "` ⇒ 不是「不会写」，而是两处口径分叉。前端 `FILE_STATUS_GROUPS`（`gitPanelUtils.ts:4-10`）用这四个键算变更列表与计数 ⇒ 重命名文件整条消失 |
| 8 | agent.js **四项** | **四项全部仍成立** | (a) `getAssistantMessages` 只处理 `typeof msg === "string"`（`:488`）而帧是对象 ⇒ 非流式 `messages` **恒空**（同类的 `getTotalTokens` 两种形态都处理 ⇒ 漏改证据）；(b) `cloneGitHubRepo` 内层 `catch {}`（`:320-322`）吞掉自己上一行的 `throw`（`:317-319`），外层 `catch {}`（`:323-325`）再吞一次 ⇒ 「路径已被别的仓库占用」在日志与响应里都不出现；(c) `existingCheckout.code !== 0` 时抛 `${checkout.stderr}`（`:979`）——引用了上一条命令；(d) `SSEStreamWriter.setSessionId` **全仓零调用**（`:419`），且 `SSEStreamWriter.send()` 不提取 `sessionId` ⇒ 流式路径 `getSessionId()` 恒 `null` ⇒ `cleanupProject` 的 session 分支（`:378-387`）不执行（非流式之所以「看起来正常」：`ResponseCollector.send()` 会从对象帧提取 `sessionId`，`:453-455`） |
| 9 | `/test-connection` **不识别掩码键** | **仍成立**（尚未触发） | `config.js:712` 无 `MASKED_SECRET` 判定，掩码原样进 `x-api-key`/`Authorization`；`/models`（`:630-638`）与 `/test-web-search`（`:113-131`）都有回落逻辑 ⇒ 同文件三处同语义判断已分叉 |

**复核口径修正**：登记 #6 是**过时项**（#365 已修），其余 8 项成立。登记确实没有夸大——9 项里
只有 1 项失效，`ui/server` 在这 11 天里对这批条目**零改动**。

### 2. 死表面退役（#356 落地）

| 目标 | 复核结论 | 依据 |
|---|---|---|
| taskmaster `/detect/:projectName`、`/detect-all`、`/initialize/:projectName`、`/next/:projectName`、`/prd` GET/POST/GET-file/DELETE | 零消费 | `ui/src`、`apps/desktop/src`、`ui/server` 内部、`tests/` 全部零命中；前端只消费 `installation-status` / `tasks` / `init` / `add-task` / `update-task` / `parse-prd` / `prd-templates` / `apply-template` 八条。连带 `detectTaskMasterFolder` / `determineTaskStatus` 成为死代码（唯二调用点是 `detect` 两条路由） |
| `/api/commands/load` | 零消费 | 前端只用 `/api/commands/list` 与 `/execute`。**且 `2026-09-15-command-path-whitelist.md` 的 Alternatives 已明文把「下线 `/load`」留给 #356 的协议面专项** —— 本次正是执行那条在先决策。策略覆盖不丢：`commandPaths.test.js`（14 例）测共享 helper，`/execute` 另有 3 例路由级用例 |
| `utils/globalChrome.js`（413 行） | 启动路径全死 | `ensureGlobalChrome` / `ensureCDPUrl` / `startChromeHealthCheck` / `restartGlobalChrome` / `isCDPHealthy` 全仓**零调用**；唯一消费是 `server-boot.js` 的关机钩子。`chrome-cdp.lock` 只由本模块的 `launchChrome` 写入 ⇒ 钩子实际只能清理**更早版本**留下的锁文件 |
| `services/always-on-paths.js` | 唯一消费者是 parity 用例 | `always-on-events.js:78` 自己 `resolve(pilotHome, "always-on", "projects")`；核心侧有独立实现（`src/cli/discoveryIo.ts:38`） |
| 前端 `taskmaster-mcp-status-changed` 监听 | 无生产者 | 见复核 #5 |

### 3. 仍成立的缺陷 → 独立载体

**不在本次退役中修**（按域拆分，每条独立 PR 可做；映射见 `backlog.md` §36，裁定表见 §26「处置追加」）。**状态更新（2026-09-17 当日）**：#411 / #414 / #415 / #416 已还清（PR #426–#429，各自的决策记录见 `2026-09-17-rewrite-turn-broadcast.md`、`2026-09-17-agent-external-api-defects.md`、`2026-09-17-git-status-rename-bucket.md`、`2026-09-17-masked-provider-key-probes.md`）；#412 / #413 仍在账：

- **#411** chat.js edit/regen 流未广播给兄弟 watcher（复核 #1）
- **#412** shell.js PTY 会话生命周期竞态 ×2（复核 #2、#3）
- **#413** sati-bridge 进程内记账 Map 无上限 / 无兜底清退（复核 #4）
- **#414** `POST /api/agent` 外部 API 四项缺陷（复核 #8）
- **#415** git `/status` 丢 rename/copy（复核 #7）
- **#416** `/test-connection` 不识别掩码 API key（复核 #9）

## Alternatives considered

- **把 9 条原样搬成 9 个 issue** —— 落选：issue 正文明确禁止；且复核后 #6 已修、#8 是**同文件同域**
  的四项，按域拆成 6 条才是可执行粒度。
- **顺手修掉几条缺陷** —— 落选：与「一个关注点一个提交」冲突，会让「删除死表面」这个**纯减法、
  零行为变化**的改动混入行为变更，回滚粒度变粗。先落地减法，后续每个行为 PR 的 diff 只剩行为面。
- **保留 `/api/commands/load`** —— 落选：#365 的决策记录已把它的下线显式留给 #356；且它的路由级
  回归用例丢失不构成覆盖缺口（策略由 `commandPaths.test.js` 直测，`/execute` 另有路由级用例）。
- **保留 `globalChrome.js` 的关机钩子、只删死导出** —— 落选：钩子读的锁文件**只能**由已死的启动路径
  写入，保留等于留一个永不生效的分支。**行为差异已明示**：升级用户若有更早版本留下的 CDP Chrome
  残留，不再被 ui/server 关停——而该进程本就不再由 ui/server 启动。
- **只写文档、不删代码** —— 落选：issue 的预期行为是「带回可跟踪状态」，而**已证零可达性**的死表面
  留着，就是下一轮复核的重复成本（正是本次要消掉的那种成本）。
- **不为退役路由留判据** —— 落选：见 Consequences。

## Consequences

- **新增 `ui/server/routes/retired-routes.test.js`**（2 例）。判据钉的是**存活路由的完整清单**，不是
  「退役路径不在表里」——后者在路由表解析为空时**恒真**（本类判据最危险的失败模式）。因此它同时防
  退役路径被静默复活与新增路由未经登记进入对外面。
  **负控制 3 条逐条命中**（串行注入、每条一日志、从备份 `cp` 还原）：
  N1 复活 `/detect-all` → 只 `taskmaster` 一例转红（`commands` 例仍绿）；N2 复活 `/load` → 只
  `commands` 一例转红；N3 把存活的 `/prd-templates` 改名 → 只 `taskmaster` 一例转红。还原后复绿。
- **指标回落**（`measure:update` 同期）：`ui/server` 文件 `105 → 104`、行数 `31783 → 30514`；
  无参 `catch {` 总计 `684 → 663`（`ui/server` `175 → 154`），其中**无注释隐患类** `125 → 114`、
  已带注释 `559 → 549`。回落**全部**来自 `ui/server`（`src + ui/src` 的 41 处无注释不变）。
- **catch 归因（逐文件，脚本对 HEAD 与工作区同口径比对，非从总量旁推）**：
  `routes/taskmaster.js` 19 → 9（无注释 −9 / 已注释 −1）、`utils/globalChrome.js` 10 → 0
  （无注释 −2 / 已注释 −8）、`services/server-boot.js` 1 → 0（已注释 −1），合计 −21 = −11 无注释
  −10 已注释，与 `metrics.md` 一致。⇒ 这是**真实下降而非口径变更**（删掉的死代码自带这些 catch），
  但**不由本次退役直接认领**：`#353` 的目标数是「无注释」全量，本次退役只是改了它的输入。
  逐文件归因表见该 issue 的处置评论。
- **`ui/server` 的行为缺陷仍无测试**：现有 8 个 `*.test.js` 不覆盖 `/ws` 与 `/shell`。本次删除
  之外的行为缺陷全部靠 #411–#416 跟踪，判据方向写在各自 issue 的「备注」里。
- **`ui/server → src` 深层导入 14 处不变**（`check-ui-server-boundary` 仍 `fresh`）——本次删除的两个
  模块都不在 `TD-BOUND-001` 的清单里；`TD-BOUND-002`（`routes/memory.js` 直连编译产物）维持
  wontfix 不变。

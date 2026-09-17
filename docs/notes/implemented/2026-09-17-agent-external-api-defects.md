# Agent Note: `POST /api/agent` 四项缺陷的修法与清理口径

Status: implemented

## Problem

`ui/server/routes/agent.js` 的对外 HTTP API（`POST /api/agent`，API key 鉴权）在同一次提交里
积累了四项互不相关、却同文件的缺陷（issue #414，复核见
`2026-09-17-ui-server-dead-surface-retirement.md` 复核 #8）：

1. **非流式 `messages` 恒空**：`ResponseCollector.getAssistantMessages()` 只处理
   `typeof msg === "string"`，而 `runChatViaGateway` 交给 writer 的是 `kind` 形态的**对象帧**
   （`stream_delta` / `complete`）⇒ `stream:"false"` 的调用方永远拿到 `messages: []`，
   却仍是 HTTP 200（静默错误）。
2. **`cloneGitHubRepo` 双层吞错**：内层 `catch {}` 吞掉自己上一行**故意**抛出的
   「目录已被另一个仓库占用」，再用通用文案替换；外层 `catch {}` 再吞一次 ⇒ 真实原因在日志与
   响应里都不出现。
3. **checkout 报错引用错变量**：`existingCheckout.code !== 0` 时抛的是 `${checkout.stderr}`
   （上一条命令的错误）。
4. **流式路径拿不到 sessionId**：`SSEStreamWriter` 不像 `ResponseCollector` 那样从帧里提取
   `sessionId`，`setSessionId()` 全仓零调用 ⇒ `getSessionId()` 恒 `null` ⇒ `cleanup:true`
   的会话清理分支永不执行。

第 4 项在修复时还暴露出一件**登记里没说对**的事：清理目标 `<homedir>/.sati/sessions/<sessionId>`
是**改名遗留**——pre-rebrand 版本写的是 `~/.pilotdeck/sessions/<sessionId>`（PilotDeck 的 CLI
会话目录），Sati 迁移只把 `.pilotdeck` 批量换成了 `.sati`，而会话转录早已搬到
`<pilotHome>/projects/<projectId>/chats/<safeId>.jsonl`（+ 同名 sidecar 目录
`file-history/`、`subagents/`）。**全仓已无任何生产者写 `<pilotHome>/sessions/`**，所以即便
把 sessionId 传对，这条分支也只是对一个不存在的目录做 `rm -rf`：既清不掉真垃圾，也长期掩盖
「清理没生效」这个事实。

## Decision

四项一次 PR 修完（同文件同域，拆开没有收益），每项一条可直测的判据
（`ui/server/routes/agent.test.js`，8 例）。

1. 抽出 `normalizeWriterFrame()`（对象帧与 legacy JSON 字符串帧统一解析）与
   `collectAssistantMessages(frames)`（`stream_delta` 连续合并为一条 assistant 消息）；
   `getAssistantMessages()` 改为它的薄封装，`getTotalTokens()` 复用同一解析入口
   —— 两处口径不再分叉。
2. `cloneGitHubRepo()` 的 `try` 收窄到**只包住读 remote 那一步**：「different repository」
   的判定移到 `catch` 之外，因而必然原样上抛；读 remote 失败才给通用文案，并把原因附在后面。
3. 抛 `${existingCheckout.stderr}`。
4. `SSEStreamWriter.send()` 与 `ResponseCollector.send()` 共用 `extractSessionId()`；
   清理目标由 `resolveSessionArtifacts(projectPath, sessionId)` 解析到**真实转录位置**，
   同时删掉 `<chats>/<safeId>.jsonl` 与 `<chats>/<safeId>/`（sidecar）。
   清理**只对本次请求新建的会话生效**（`sessionCreated`：writer 收到过 `kind:"session_created"`
   帧），调用方自带 sessionId 指向既有会话时不动它的转录。

## Alternatives considered

- **只修 sessionId 传递、不动清理路径** —— 落选：这正是本次修完仍无收益的那种改法。
  传对 sessionId 之后删的是不存在的目录，缺陷从「静默不清理」变成「静默不清理但参数对了」，
  真垃圾（`projects/<id>/chats/*.jsonl`）照旧留在盘上。
- **清理时删掉整个 `chats/` 目录** —— 落选：那是项目级目录，同项目下可能有别的会话；
  按 `<safeId>` 只删本次会话的两项才对得上「一个会话一份产物」的布局。
- **不设 `sessionCreated` 门，按 sessionId 一律删** —— 落选：`cleanup` 的触发条件是
  「给了 `githubUrl`」，而 `projectPath` 可以指向一个**已存在**的仓库；此时调用方传进来的
  sessionId 很可能就是它自己的历史会话。删掉等于为了清临时目录而销毁调用方的转录，代价不可逆。
- **顺手删掉这条清理分支（视为死代码）** —— 落选：死的是**路径**不是**意图**；`cleanup:true`
  对一次性克隆本就该把会话产物一起收走，把意图实现到真实位置比删掉意图更符合 API 文档。
- **拆成四个 PR（每项一个）** —— 落选：四项同文件同域且互不冲突，单独拆开只会让
  `agent.js` 的 diff 与 CI 成本 ×4，收益为零。

## Consequences

- **对外响应体变化（两处，均为「修好」）**：`stream:"false"` 的 `messages` 从 `[]` 变为真实
  助手消息列表；`stream:true` + `cleanup:true` + `githubUrl` 的调用现在**真的会删除**该会话的
  转录与 sidecar 目录（此前 `~/.sati/sessions/<id>` 恒不存在，等于什么都没删）。
- **失败可诊断**：`cloneGitHubRepo` 冲突与 `checkout` 失败现在都带上真实原因，
  排障不必再读两个进程的日志。
- **负控制 5 条逐条命中**（注入回退、跑对应用例转红、还原复绿）：
  N1 只认字符串帧 → 非流式判据转红；N2 恢复双层吞错 → 冲突文案判据转红；
  N3 改回 `${checkout.stderr}` → checkout 判据转红；
  N4 `SSEStreamWriter.send()` 去掉提取 → 流式 sessionId 判据转红；
  N5 清理路径指回 `projects/<id>/`（少一层 `chats`）→ 转录删除判据转红。
- **仍未覆盖（本 PR 故意不碰）**：`cleanupProject()` 的「只清理 external-projects 直属子目录」
  守卫读的是 `os.homedir()`，而转录路径读的是 `SATI_HOME`（`resolvePilotHome()`）——
  非默认 `SATI_HOME` 的部署里项目目录守卫与产物位置可能指两处；且克隆项目的注册项
  （`projects/<id>/.cwd` 等）在克隆目录删除后依旧留存。两者都与本次四项缺陷不同源，
  留待独立载体。
- 判据用假 `git` 注入（PATH 上的可执行脚本）而非 mock 内部函数：断言的仍是「本路由如何解读
  git 的结果」，换实现（不换契约）时判据不失效。

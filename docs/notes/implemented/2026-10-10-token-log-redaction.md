# Agent Note: WS / Git / IM 日志中的凭证脱敏

Status: implemented

## Problem

三个日志面会把凭证原样写进服务端日志或错误消息：

1. **`/ws` 握手**——`ui/server/websocket/chat.js` 的 `verifyClient` 记录 `info.req.url`，而浏览器把 auth token 放在 query（`/ws?token=…`、`/shell?token=…`），整串 URL 进日志即凭据落盘。
2. **Git clone 失败**——`ui/server/routes/agent.js` 把 token 拼进 URL 的 userinfo 段（`https://<token>@github.com/owner/repo`），git 失败时 stderr 回显该 URL，而这段文本既被记日志、又被当作错误消息返回客户端。
3. **IM 渠道的 URL 鉴权**——Mattermost 的 ws URL（`?token=`）与 WeCom 的 `gettoken`（`?corpsecret=`）/ `sendReply`（`?access_token=`）把凭证放在 query，失败路径记录异常对象正文。

凭证是否真的出现在错误正文里取决于失败形态，故先实测（`ws` 与 `fetch` 均在本仓 node_modules 内）：

| 触发 | 结果 |
|---|---|
| `ws` 连接被拒（ECONNREFUSED） | 正文 `connect ECONNREFUSED 127.0.0.1:1`，**不含** URL |
| `ws` URL 畸形 | `SyntaxError: Invalid URL: not-a-url?token=SECRET…`，**含**凭证 |
| `fetch` URL 畸形 | `TypeError: Failed to parse URL from not-a-url?access_token=SECRET…`，**含**凭证 |

即泄漏面窄但真实：只在 URL 解析失败（配置错误形态）时命中。

## Decision

- `ui/server/websocket/chat.js` 的握手日志只记 path：`info.req.url?.split("?")[0]`（与上游 PilotDeck 同形）。token 提取逻辑不动。
- 新增 `ui/server/utils/redactSecrets.js`（`redactSecrets`）：替换凭证名 query 参数（`token` / `access_token` / `api_key` / `key` / `secret` / `password` 等）与 URL userinfo 段（`user@` 与 `user:pass@` 两种形态）。`ui/server/routes/agent.js` 的 git stderr 在**记日志与抛出之前**都过一遍，`onStderr` 回调同样处理。
- `src/shared/credentialRedaction.ts` 新增导出 `redactUrlCredentials`（**不改** `sanitizeOutgoingText` 语义）：Mattermost 两处 ws 错误日志、WeCom `sendReply` 的 catch。WeCom 的 `getAccessToken` 抛错落进同一个 catch，故一处覆盖两条 URL。
- 全仓排查了「URL 中携带凭证」的构造点，仅上述三处 + `ui/server/middleware/auth.js`（只记 jwt 校验错误对象，不含 URL）与 `src/gateway/server/`（token 走帧内字段 `frame.token`，非 URL，且无 token 日志），后两者已核对、无需处理。

## Alternatives considered

- **只改 `chat.js` 一行（照抄上游那次修复）** —— git stderr 与 IM 渠道是同一缺陷类，分开修会让「已修」与「未修」在日志面上不可区分；日志是凭据外泄的持久面，一次收口更可信。
- **让 `sanitizeOutgoingText` 直接覆盖 query 参数** —— 它作用于**模型入参**（`sanitizeAgentInput`）与路由事件落盘（`classifyAndRoute`），其 `URL_CREDENTIALS_RE` 刻意要求冒号以缩小误伤；放宽会改变模型可见文本与事件落盘格式，属另一类变更。
- **`ui/server` 复用 `src/shared/credentialRedaction.ts`** —— 违反架构边界（`ui/` 不得导入 `src/`），会被 `scripts/check-ui-server-boundary.mjs` 拦下。
- **引入日志框架级全局脱敏钩子** —— 需替换 `consoleLogger`（现为纯转发、明确「不加前缀、不改变输出文本」），会改变所有日志的既有形态并影响既有 grep/消费方式；本次只需堵三个已知构造点。
- **Git 侧改用 credential helper / `GIT_ASKPASS`，不把 token 放进 URL** —— 更彻底（URL 里根本不存在凭证），但要改 clone 命令与认证链路，且对 WS/IM 两面无收益；记为后续可选加固，不阻塞本次。

## Consequences

- **换来**：三个构造点的凭证不再进入日志与客户端可见的错误消息；新增两条可执行判据——`ui/server/websocket/chat.test.js` 的握手日志断言（真实 HTTP + 真实 WS + 真实 `verifyClient`，回退修复即变红）与 `tests/shared/credential-redaction-url.spec.ts`。
- **付出**：`ui/server` 与 `src/shared` 各有一份脱敏实现，需同向维护（架构边界使然，非疏漏）；`redactUrlCredentials` 只覆盖「凭证名 query 参数 + URL userinfo」两种形态，不是通用秘密扫描器；Mattermost/WeCom 的泄漏是**防御性**修复——用 `ws`/`fetch` 的畸形 URL 复现了同形泄漏，但未在真实渠道配置下复现端到端。
- **未覆盖（明示）**：`ui/server/middleware/auth.js` 的预览 token 校验错误日志经核对不含 URL。上游 `fix: workspace token cleanup`（**#620**）的语义**已定位并核验**：本项目有且完全等价——`create-workspace` / `clone-progress` 在 token 查不到时会递归删除目标目录，而 `workspaceType: "new"` 并不要求该路径事先不存在，于是连已存在的父目录一起删。该缺陷已随 #620 移植修复（见 `2026-10-15-workspace-parent-preserve.md`），本条「未核验」至此关闭。

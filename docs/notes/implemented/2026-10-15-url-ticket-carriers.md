# Agent Note: 去 URL 会话 JWT：统一 URL 票据覆盖无头载体（#626）

Status: implemented

## Problem

#615 把项目预览的会话 JWT 收窄成了项目预览凭据，但在其「残余风险」里明确登记了一条同源面（`2026-10-08-preview-credential-and-csp.md` 第 68 行）：`/api/projects` 下的**通用接口仍接受会话 JWT 的 query 形式**，且 `authenticateToken` 还额外从 **Referer** 里截取 memory-dashboard 子资源的会话 token。默认登录模式下，多个「无法自定义 HTTP 头」的载体把**长 TTL 的完整会话 JWT**直接拼进 URL：

1. `GET /api/projects/:name/files/content` —— PDF `<iframe>` 预览与 `<a download>` 下载；
2. `GET /api/projects/:name/files/preview/pdf` —— Office 打印预览 `<iframe>`；
3. `GET /api/projects/:name/files/preview/spreadsheet/sheet` —— 工作表 `<iframe>`；
4. `GET /api/gateway/qr-image` —— 三个 IM 集成页的 `<img>` 二维码；
5. `GET /api/projects/clone-progress` —— `EventSource`（SSE）克隆进度；
6. `GET /memory-dashboard/*` —— 记忆面板 `<iframe>` 文档 + 同目录子资源。

这些 URL 会经浏览器历史、`Referer`、反向代理与服务端访问日志、以及「复制链接」外泄；一旦泄露即等于账户完整权限。前端把 token 拼进 URL 的公共 helper 是 `api.js` 的 `appendAuthToken`。

## Decision

复用 #615 的预览凭据范式（scoped + 短 TTL + 通用鉴权拒带 scope 的 token），把它泛化成一枚通用 **`url-ticket`**，逐载体替换会话 JWT，并**移除** `authenticateToken` 的 `req.query.token` 回退与 `extractDashboardRefererToken`。

**1. 票据基础设施（`ui/server/middleware/auth.js`）**

- `generateUrlTicket(user, { purpose, project, path })` 签发 `{ userId, scope: "url-ticket", purpose, project?, path? }`。purpose 白名单 `file | qr | sse | dashboard`；TTL 分别 `300 / 300 / 300 / 900` 秒（dashboard 稍长，供 cookie 携子资源复用，参照 #615 的 15 分钟量级）。
- 新增 `POST /api/url-ticket`（`ui/server/routes/url-ticket.js`），走 `authenticateSessionOnly`——**只认 Authorization 头里的会话 token**，不接受 query 票据或 cookie，杜绝用一份短票据续换更长/更宽的票据。purpose 越界一律 400。
- `authenticateToken`：无 Authorization 头时改由 `verifyUrlTicket` 读 `?ticket=`。它要求 `decoded.scope === "url-ticket"`（会话 JWT 或别的 scoped 凭据塞进 `?ticket=` 一律 403）；放行前 `userDb.getUserById` 校验存在，命中即 `req.user = user; next()`——**不进入**会话 auto-refresh，绝不换发会话 token。原「header token 带 scope → 403」保留。

**2. 绑定校验（按「请求侧」驱动，防跨载体复用）**

`verifyUrlTicket` 用请求暴露的槽位反推票据必须携带的绑定：

- 项目级路由（`req.params.projectName !== undefined`）要求 `decoded.project === req.params.projectName`；
- 文件级路由（`typeof req.query.path === "string"`）要求 `decoded.path === req.query.path`。

于是 `file` 票据天然带 project+path、被逐条校验；而 `qr`/`sse`/`dashboard` 这类 purpose 级票据不带 project，落到带 `:projectName` 的文件路由会被直接拒绝——低价值票据无法读项目文件，反向亦然。

`/api/projects` 与 `/api/gateway` 的挂载不变：`authenticateToken` 现在透明接受 `?ticket=`。**SSE 特例**：`clone-progress` 复用 `?path=` 承载「工作区目录」（与文件路由的 `?path=` 同名但语义不同），故前端为该请求签发的 `sse` 票据**绑定工作区路径**（`requestUrlTicket("sse", { path })`），恰好满足请求侧 path 校验，而无需给通用鉴权加路由级 purpose 判定。

**3. memory-dashboard：票据 + 路径限定 cookie（`authenticateMemoryDashboard`）**

镜像 `authenticateProjectPreview`：①会话头 → 委派 `authenticateToken`；②文档导航 `?ticket=`（校验 purpose=`dashboard`）→ 命中即 `Set-Cookie: sati_dashboard=…; Path=/memory-dashboard; HttpOnly; SameSite=None; Secure`；③子资源带 cookie 放行（不重复种，避免 TTL 刷新）。`system.js` 的 `GET /memory-dashboard` 与静态挂载都改用它。Referer 不再是任何凭据来源。

**4. 前端（`ui/src/utils/api.js` + 载体组件）**

- 新增 `requestUrlTicket`；`fileContentUrl`/`officePdfPreviewUrl`/`spreadsheetSheetPreviewUrl`/`fileDownloadUrl` 改为**异步**（先换票据再拼 `?ticket=`）；**删除 `appendAuthToken`**。
- 头部可用的消费者（`readFileBlob`/`readOfficePdfPreviewBlob`/`preflight*`）改请求**不带凭据**的裸 `*Endpoint`，凭据只走 Authorization 头。
- 载体接入：`PdfPreview` 与 2 个 preview-url hook 用 state+effect 异步取 URL；下载入口收敛进 `use-download-url` hook（PdfPreview/OfficePreview/Builtin/SpreadsheetPreview(+Toolbar)/DownloadButton/MessageFileCards/FilesV2）；三个 IM `<img>` 用共享 `useQrImageSrc`（`requestUrlTicket("qr")`）；`workspaceApi` 的 SSE 改 `await requestUrlTicket("sse")`；`MemoryPanel` 的 dashboard iframe 用 `requestUrlTicket("dashboard")` 异步设 src。

## Alternatives considered

- **本 PR 一并迁移 WebSocket（`/ws`、`/shell`）** — 落选，登记为残余。WS 走独立的 `authenticateWebSocket`（`token` 参数），不受通用 query 回退移除影响，仍可正常连接；迁移到 WS 票据或首帧鉴权要动 socket 协议面与连接生命周期，成本与风险都超出「切断 REST/SSE/dashboard 的会话 JWT」这一目标。拆后续 PR。
- **保留 Referer 作为 dashboard 子资源的凭据来源** — 落选。Referer 是第二处会话 token 泄露源：跨源跳转会带出、浏览器策略与代理重写使其不可靠、且子资源 URL 本身不含凭据却要依赖宿主头，语义脆弱。改用「文档 `?ticket=` 种路径限定 HttpOnly cookie」——与 #615 预览同构、已验证可携。
- **票据绑定改为「按票据声明」判定（`decoded.path !== undefined` 才校验）** — 落选。那样一份无 path 的 `qr`/`sse` 票据在带 `?path=` 的文件路由上会被放行（path 检查被跳过），恰好打开跨载体复用的口子。坚持「按请求侧槽位」驱动：文件路由有 path 槽就要求票据带 path。
- **给 `sse` 票据只做 purpose、不带 path 绑定** — 落选。`clone-progress` 复用 `?path=` 承载工作区目录，请求侧 path 校验会用 `undefined !== 工作区路径` 拒掉合法票据。绑定同一工作区路径既过校验又把票据钉死在一次克隆上，顺带收窄复用地。
- **dashboard 票据绑定 projectPath** — 落选。dashboard 内容始终是当前用户自己的项目记忆，跨项目复用无越权；purpose 级足够，服务端也不校验该绑定，绑定徒增签发端点参数而无收益。
- **cookie 用 `SameSite=Lax` / 不加 `Secure`** — 落选，沿用 #615 结论：沙箱/相对子资源实测只有 `SameSite=None; Secure` 能被携带。代价是局域网 http（非安全源）下浏览器拒存该 cookie，dashboard 子资源随之降级——与 #615 预览 cookie 完全相同的已知分叉，由界面提示，不在本次消除。

## Consequences

**换来的：**

- 六类载体的 URL 不再出现会话 JWT；`?token=` 回退与 Referer 取 token 两条泄露源被切断，`appendAuthToken` 从前端消失。
- 外泄的 URL 顶多是一枚 5–15 分钟、scope 受限、绑定具体项目/路径（或仅一个 purpose）、且不能被任何其它 API/WebSocket 当会话复用的一次性票据。
- 一份票据无法跨载体/跨项目/跨路径复用（请求侧绑定校验 + purpose/scope 双重钉死）。

**付出的：**

- 旧的、带 `?token=` 会话 JWT 的预览/下载/dashboard URL（收藏夹、分享链接）失效并返回 401；重新点击即可。
- 进入预览/下载/dashboard 需先异步换票据，有一瞬空白（未渲染 iframe/`<a>`/`<img>`）；票据过期后重载会重新申请。
- 登录模式下局域网 http 访问时 dashboard 子资源 cookie 被浏览器拒存而降级（同 #615，已知残余）。

**残余风险（已知，本 PR 不闭，登记后续）：**

- **WebSocket `/ws`（`WebSocketContext.tsx`）与 `/shell`（`socket.ts`）仍从 `?token=` 取会话 JWT**（独立 `authenticateWebSocket`，不受本次回退移除影响，故仍可用）。后续 PR 迁移到 WS 票据或首帧鉴权。
- 默认免登录（`DISABLE_LOCAL_AUTH`）下所有鉴权整体旁路、票据化不改变行为；二者在测试中都覆盖。

**验证证据（2026-10-15）：**

- 后端：`ui/server/middleware/urlTicket.test.js`（19，含合法票据/绑定不匹配/过期/会话 JWT 塞 `?ticket=`/`?token=` 回退已删/Referer 不再取凭据/票据分支不触发 auto-refresh 不换发会话/签发端点只认会话头），`memoryDashboardAuth.test.js`（11，文档票据种 cookie、子资源带 cookie、无凭据 401、Referer/`?token=` 会话 JWT 被拒），并更新 `projectPreviewAuth.test.js` 两处原「保留 query 会话 token」的判据以锁死新行为。
- 前端：`api.urlTicket.spec.ts`（8，`*Url` 拼 `?ticket=` 且不含会话 JWT、裸 `*Endpoint` 走 Authorization 头、`appendAuthToken` 已移除），`workspaceApi.test.ts`（2，SSE `EventSource` URL 携 path 绑定票据、失败不回退拼 token），`MemoryPanel.test.tsx`（3，dashboard iframe `?ticket=`），改造 `WeixinChannelSection.test.tsx`（QR 走 `requestUrlTicket`）与 `CodeEditorBinaryFile.test.tsx`（PDF/打印预览异步）。
- `pnpm --filter sati-ui test`：189 文件 / 1344 用例全绿。

# Agent Note: 项目预览凭据收窄与预览 CSP（P0 凭据外泄修复）

Status: implemented

## Problem

项目预览路由（`GET /api/projects/:name/preview/*`）把项目里的 HTML 原样流式输出，文档脚本与应用同源。此前两个条件叠加，使项目内任意 HTML 都能取得**完整会话凭据**：

1. 预览 URL 由 `appendAuthToken` 拼入 localStorage 中的会话 JWT（`?token=`）；
2. 预览路由无 CSP、无 `sandbox` 头。文档脚本因此能读 `location.search` 外发 token；在新标签页直开时还能直接读 `localStorage["auth-token"]`（该页与应用同源，iframe 的 `sandbox` 属性管不到顶层导航）。

会话 JWT 能调用任何 `/api/*` 接口，因此这是项目文件内容即可换取账户完整权限的缺陷。

独立审查（oracle）与真实浏览器探针进一步揭示：**沙箱只加在预览路由上并不足够**。同源的 `GET /api/projects/:name/files/content` 原样内联输出项目文件且无 CSP，沙箱文档经 `location.href` 自导航、`<meta http-equiv="refresh">` 或 `window.open` 跳转到它后，新文档不再受沙箱约束，以应用源运行——在默认（本地免登录）模式下实测可以 `fetch /api/auth/status` 取得成功。这要求把同源可渲染的文档类响应统一纳入沙箱策略。

## Decision

分两道防线，并收窄凭据：

**1. 预览凭据（scope 绑定项目、15 分钟过期）**

- 新增 `POST /api/projects/:name/preview-token`（会话鉴权），签发 `{ userId, scope: "project-preview", project }`。
- 预览 URL 只携带该凭据，不再携带会话 JWT。
- 预览路由使用 `authenticateProjectPreview`：接受 `Authorization` 头中的会话 JWT（程序化请求），或 query 中**同项目**的预览凭据；query 中的会话 JWT 一律拒绝。
- 通用鉴权（`authenticateToken`）与 WebSocket 鉴权**拒绝任何带 `scope` 的 token**：泄露的预览凭据无法当作完整会话调用其它接口。

**2. 预览响应安全头（`ui/server/middleware/projectPreviewSecurity.js`）**

- `Content-Security-Policy`：`sandbox allow-scripts allow-forms allow-modals allow-popups`（不含 `allow-same-origin`），使文档**即使顶层打开也是不透明源**；`connect-src 'none'` 切断 fetch/XHR 外发；`img-src 'self' data: blob:` 不放行任意外部图片；`script-src` / `style-src` / `font-src` 放行 `'self'`（项目内 sibling 资源，实测沙箱下 `'self'` 有效）与 Chart.js CDN、Google Fonts（白名单，见 `PROJECT_PREVIEW_EXTERNAL_HOSTS`）。
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
- `files/content` 复用同一策略：`applyProjectFileSecurityHeaders` 对**可渲染为脚本文档的 MIME**（`text/html`、`application/xhtml+xml`、`image/svg+xml`、`text/xml`、`application/xml`）附加相同的沙箱 CSP 与 `no-referrer`，对所有项目文件附加 `nosniff`。图片、PDF 等非文档类型不加沙箱头，避免影响 `<img>` 与 PDF 预览的渲染（实测 PNG 仅 `nosniff`、HTML 带全量沙箱头）。`.mht/.mhtml`（`message/rfc822`）强制 `Content-Disposition: attachment`，从渲染面移除。

**3. 路由挂载顺序**

`projectPreviewRoutes` 前移到 `/api/projects` 全局鉴权挂载之前。该全局挂载的 `authenticateToken` 会先于预览路由执行，否则会拒绝预览凭据、并使会话 query 的拒绝逻辑形同虚设。前移后该 router 的 7 条路由逐条核对，均自带鉴权（`authenticateToken` 或 `authenticateProjectPreview`），并由守卫测试 `ui/server/routes/project-preview.auth.test.js` 锁定：遍历真实 router 断言每条路由带鉴权，且路由清单变化时测试失败以强制审查。

前端：`api.projectPreviewUrl` 改为异步（先申请凭据）；`CodeEditor` 在进入预览时才申请；`FilesV2` 的新标签页先同步开 `about:blank` 保住用户手势，取到地址后再导航并断开 `opener`。

## Alternatives considered

- **只加 CSP，保留会话 JWT 在 URL 中** — 落选。`location.search` 仍可读，token 仍能外发到任何被放行的源；CSP 只能缩小外发通道，不能阻止文档读取 URL。
- **预览改用 Cookie 会话（HttpOnly）** — 落选。沙箱不透明源发出的请求是否携带 SameSite Cookie 的行为不稳定，且引入 CSRF 面需要另行设计；收益不及本方案。
- **`srcdoc` / `blob:` 注入 HTML** — 落选。相对资源（同目录的 CSS/图片）的 base 解析会失效，且仍需解决凭据问题。
- **为预览单独起一个隔离域名（独立 origin）** — 暂缓。隔离最彻底，但需要部署与反向代理改造，超出本次范围；待标注（H 系列）需要更强隔离时再评估。
- **仅收窄凭据、不加 `sandbox` 头** — 落选。顶层新标签页仍与应用同源，`localStorage` 中的会话 token 直接可读（真实浏览器实测复现）。
- **仅 iframe `sandbox` 属性，不加头** — 落选。属性只约束嵌入场景，不覆盖直开标签页。
- **沙箱只加在预览路由（初版实现）** — 落选。同源导航到无 CSP 的 `files/content` 会脱离沙箱，真实浏览器探针证实三条导航路径（自导航 / meta refresh / window.open）均可逃逸并在默认模式下调用应用 API。改为文档类 MIME 统一加沙箱头。

## Consequences

**换来的：**

- 文档脚本读不到会话 JWT，无法以用户身份调用 API；泄露的预览凭据只读取本项目的预览文件，15 分钟过期。
- 真实浏览器验证（未入库的临时探针，Playwright + 无头 Chromium + 真实服务端）：
  - 改动前路径（会话 token 在 URL、无 CSP）：`localStorage` 可读且外发 2 次命中；`files/content` 逃逸后以应用源 `fetch /api/auth/status` 返回 200。
  - 改动后：预览顶层与 iframe 均 `SecurityError`、外发 0 次命中；三条逃逸路径（自导航 / meta refresh / window.open）落点的文档全部变为不透明源（API 调用 `BLOCKED:TypeError`、`localStorage` `SecurityError`）；sibling 的 JS/CSS/图片正常加载，内联脚本正常运行。
- 真实服务端矩阵（登录模式，当前 HEAD）：会话 JWT 放预览 URL → 403；预览凭据访问本项目预览 → 200；预览凭据访问其它项目 → 403；预览凭据调用 `files/content` → 403；无凭据 → 401；会话头 → 200；`files/content` 的 HTML 带沙箱 CSP + nosniff、PNG 仅 nosniff。

**付出的：**

- 旧的、带会话 token 的预览 URL（例如收藏夹）失效，返回 403；用户重新点击即可。
- 预览凭据 15 分钟过期：长时间保持的 iframe 若被浏览器重新加载，会 403；切换文件或重新进入预览会重新申请。
- 标注模式前的预览面需要异步拿到 URL，进入预览时有一瞬间的空白（未渲染 iframe）。

**残余风险（已知，未在本次修复）：**

- **默认（本地免登录）模式下 `cors()` 默认放行任意来源（`Access-Control-Allow-Origin: *`）**，且鉴权整体旁路。此时任何网页都能从用户浏览器读取本机 Sati 的 API（含项目文件）。这是与标注无关的既有面，独立于本次修复；本 PR 未扩大它，但建议单独立项评估（本地模式是否应限制 CORS / 绑定回环地址 / 强制启用鉴权）。
- `/api/projects` 下的**通用接口仍接受会话 JWT 的 query 形式**。`fileContentUrl`（`PdfPreview` 的 iframe、下载链接）与 SSE 依赖此行为。若这些地址被用于承载不可信内容且可执行脚本，同样存在外泄面。下一步应为它们各自签发收窄的凭据，或只为 SSE 保留 query 会话。
- `ui/server/routes/plugins.js` 以原始字节输出插件资源，未加沙箱头。插件是用户显式安装的可执行扩展（其 UI 本身即应用的一部分），与项目内容信任级别不同；列入后续审查。
- CSP 白名单中的 CDN 若不可达，依赖它们的模板会降级（图表空白），这是预期的失败模式，不是安全问题。
- `extractProjectDirectory` 对绝对路径形式的项目名不校验存在性（既有行为，mint 端点对不存在的绝对路径仍返回 200）。预览路由本身仍会在解析后返回 404/403，不构成越权。
- 登录模式下 sibling 资源不携带凭据（相对 URL 无 Authorization 头），项目内 HTML 的本地相对资源在登录模式仍不可加载——既有行为，与本次改动无关（标注 H0 spike 需跟进）。

**验证证据（2026-10-08）：**

- 单测：`ui/server/middleware/projectPreviewAuth.test.js`（12）、`projectPreviewSecurity.test.js`（25）、`ui/server/routes/project-preview.auth.test.js`（8）、`ui/src/utils/api.projectPreviewUrl.spec.ts`（3）、`ui/src/utils/openProjectPreview.spec.ts`（4）全部通过。
- ui 全量 vitest：174 个文件、1214 个用例全部通过。
- `tsc --noEmit`、`eslint --max-warnings 0`、`biome check`、`pnpm check` 全部通过；`pnpm measure:update` 已按规则在同 PR 刷新指标基线。
- 真实浏览器（Playwright 1.62 + 无头 Chromium）对比改动前后，见上。

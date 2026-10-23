# Agent Note: 本机 API 的请求来源守卫，与 git / taskmaster 路由族的授权收口

Status: implemented

> 后续变更（2026-10-23）：默认绑定改为 `127.0.0.1`，私有地址 / 本机主机名不再隐式可信，
> 须显式登记 `SATI_TRUSTED_HOSTS`；见 `2026-10-23-loopback-default-and-explicit-lan-trust.md`。

## Problem

上一批把「项目文件路由族的 root 只认项目注册表」落了地，代码审查指出三条与本批同一威胁模型、
但当时未收口的缺口（记录在 `2026-10-15-project-file-root-authorization.md` 的「未覆盖」里）：

1. **`git.js` 自己就是文件内容面**：`/file-with-diff`、`/diff`、`/commit-diff` 把工作树内任意文件
   逐字读出来，`/discard`、`/delete-untracked` 删文件，`/checkout`、`/create-branch` 改分支，而
   root 来自 `extractProjectDirectory(project)`（绝对路径原样透传 + 短横线解码）。用户 home 若是
   git 工作树（dotfiles 常见），`?project=<home 路径>&file=.sati/server-token` 可直接读出令牌。
   `/checkout` 与 `/create-branch` 还是唯二没有 `validateGitRepository` 的路由。
2. **`taskmaster.js` 是「任意路径写 + CLI 副作用」面**：同样的 root 推导，加上 `fileName` /
   `prdFile` 直接来自 `req.body` 拼进 `path.join(root, ".taskmaster", "docs", fileName)`；
   `apply-template` 据此写文件，`parse-prd` 据此起 CLI，且这些 CLI 都以 `shell: true` 起
   （`add-task` 的 `prompt`、`update-task` 的 `prompt` 也进同一个 shell）。
3. **授权源本身可由同一通道写入，而通道无来源校验**：`POST /api/projects/create-workspace` 能把任意
   现有目录登记成工作区；本机默认免登录（`DISABLE_LOCAL_AUTH` 默认真），`index.js` 的 `cors()` 又
   放行任意 origin。于是**用户浏览器里任意一个网页**都能 `fetch()` 本机 API 并读到响应——注册目录、
   读写文件、甚至开 WebSocket 聊天（`verifyClient` 在免登录模式下同样只放行）。

第 3 条与其余两条不是同一类：它是**认证边界**问题，先注册再访问就绕过了「root 只认注册表」。

## Decision

### 一条共用判定链（`services/projectRoot.js`）

`resolveAuthorizedProjectRoot(name, { env, allowAppHomeOverlap })` 成为「已授权 root」的唯一定义：
注册表解析 → 与 app home 重叠即拒（词法 + `realpath` 各判一次）→ 目标须是真实目录。HTTP 守卫
（`middleware/projectFilesystem.js`）、git 路由族、taskmaster 路由族都调它，不再各写一份。

- **`git.js`**：`getActualProjectPath()` 改调 `resolveAuthorizedProjectRoot`（20 个调用点共用一处
  判定）；`/checkout`（`:723`）与 `/create-branch`（`:747`）补上 `validateGitRepository`；
  删掉只拒空值/NUL/非绝对/根目录的 `validateProjectPath`（注册表判定严格得多）。`general`（root 即
  app home）在 git 面同样被拒。
- **`taskmaster.js`**：6 个项目面挂同一个守卫并改用 `req.projectRoot`；`fileName` / `prdFile` 经
  `resolveDocsFileName` 收口为**单个文件名**（拒 `/`、`\`、`..`、NUL，非法回 400）；
  7 处 `shell: true` 全部去掉。

### 本机模式的请求来源守卫（`middleware/localOriginGuard.js`）

**与 #625 的关系（合流时补记）**：本批开发期间 main 上先合并了 #680（`middleware/corsPolicy.js`，
「跨站来源收窄」），它替换了 `index.js` 里原先无条件的 `cors()`，判据为「无 Origin / 同源 / 环回 /
`SATI_ALLOWED_ORIGINS` 白名单」。两者职责相邻但**不可互相替代**，故合流后保留为**两层**：

- `corsPolicy()`：负责跨站与 CORS 头（可信跨源反射 Origin + 凭据），服务跨机/反代部署；
- `localOriginGuard`（本层，仅本机免登录模式）：在它之后再加一道「`Host` 与 `Origin` 都必须是本机
  可达名」。**少了本层，DNS rebinding 会漏**：攻击页自己跑在同端口（`http://evil.com:3001`）时，
  请求的 `Origin` 与 `Host` 同为主机名 `evil.com`，正好命中 `corsPolicy` 的「同源」判据而放行。
  这条已钉成用例（`localOriginGuard.test.js` 的「与 corsPolicy 叠加」：单挂 `corsPolicy` 该形态
  回 200，两层叠加回 403）。

两层的语义不能互换：`corsPolicy` 的判据若塞进「Host 必须本机可达」，会把「`SATI_ALLOWED_ORIGINS`
登记的跨机部署」一并打断（那里 `Host` 本就是公网域名）；反过来 `localOriginGuard` 不负责 CORS 头。

本层挂在 `corsPolicy()` 之后、所有路由之前；`enabled = DISABLE_LOCAL_AUTH && !IS_PLATFORM`
（托管部署有真实 JWT，且 Host 是公网域名，不启用）。`Host` 与 `Origin` **两个头各自过同一套
「本机可达名字」判定**（回环名/地址、私有地址字面量、`os.hostname()` / `<hostname>.local`，或显式
`SATI_TRUSTED_HOSTS` 里列出的名字）：

1. `Host` 这一半挡 **DNS rebinding**：攻击者的域名解析到 127.0.0.1 时，请求的 `Host` 就是那个
   公网域名，不是本机名字。
2. `Origin` 这一半挡 **外部网页直连**：跨站 `fetch` 必带 `Origin`（值即页面来源），
   `Origin: null`（沙箱 iframe / `file://` 页面）解析不出主机名，同样不算本机来源。

两半都**不要求** `Origin` 与 `Host` 相等——这点是被实测纠回来的：Vite 的字符串简写代理
（`ui/vite.config.js` 的 `"/api": "http://…:3001"`）默认 `changeOrigin: true`（vite 8.3.0
`dist/node/chunks/node.js:19375-19378`），会把 `Host` 改写成代理目标，而页面 `Origin` 仍是
`127.0.0.1:5173`：按「相等」判会把 `pnpm dev` 整条打断。

无 `Origin` 的请求（curl、Node 客户端、Electron 主进程 `/health`、同源 GET 导航）只看 `Host` 这一半。
WebSocket 握手（`websocket/chat.js` 的 `verifyClient`）用同一个 `isTrustedRequestSource`——握手不受
CORS 约束，本机免登录模式下跨站页面同样能发起。命中回 403 `UNTRUSTED_REQUEST_ORIGIN`，文案里给出
`SATI_TRUSTED_HOSTS` 这条逃生口。

**边界（不夸大，实测口径）**：挡住的是**公网来源**——外部网页、rebinding 域名、`Origin: null`。
**本机其它端口的页面不在防护内**（浏览器实测：从 `127.0.0.1:8899` 的页面发起的 `fetch` 与
WebSocket 都能通过），因为本机进程本来就能直连 API，浏览器只是它们的另一条通路；要收紧到「同
host:port」会顺带打断 dev（见上）与所有本机多端口部署，收益不抵代价。

### 顺带修复的既有缺陷：git 面板的非 ASCII 路径

浏览器验证时发现 Git 面板在本机工作区（文件名含中文）里列出的路径是 `"/344/270/223/…"` 这种乱码，
点开必然 404。成因**不是**本批改动：`git status --porcelain` 默认开 `core.quotepath`，对非 ASCII
路径做 C 风格转义并套引号，而 `normalizeRepositoryRelativeFilePath`（`git.js:218`）把反斜杠当
Windows 分隔符统一换成 `/`，转义被碾成 `/344/270/…`（用 `git show HEAD:git.js` 核对过
`parseStatusBuckets` 与本批改动前逐字节相同）。修法是给**解析路径的** git 调用加
`-c core.quotepath=false`（`RAW_PATH_ARGS`，4 处：3 个 `status --porcelain` + `log --stat`），
让 git 直接吐原始 UTF-8。实测后面板显示真实中文名、点开能读出内容（`Lines: 155 / Characters: 4334`）。

### 次要件（审查的 Minor）

- `resolveRegisteredProject` 的绝对路径分支先按 `createProjectId` 直接定位候选目录（常见情形
  由 O(项目数) 的串行扫描降为 O(1)），未命中再全表扫描；
- 扫描里除词法等值外再比一次 `realpath`（macOS `/var` ↔ `/private/var` 这类别名不该判成「未注册」），
  返回值始终是登记里的路径，不是请求方给的；
- 去掉 `readRegisteredProject` 里两处恒真的 `isSymbolicLink()`（`lstat` 不跟随软链，软链的
  `isDirectory()`/`isFile()` 恒假，类型判定本身已经挡住）；
- 接线契约测试补一条「框架路由表（`router.stack`）与源码扫描结果一致」的自校验。

## Alternatives considered

- **只收紧 CORS（不再 `origin: *`），不做服务端判定** —— 不够：跨站的「简单请求」（表单编码 POST）
  不触发预检，浏览器照发，副作用已经发生（注册目录就是副作用）；CORS 只能挡住**读响应**。
- **只校验 `Origin`，不校验 `Host`** —— DNS rebinding 仍开门：攻击者让页面与 API 同源
  （`evil.com` 解析到 127.0.0.1），`Origin` 与 `Host` 都是那个域名，第一条判据不成立就漏。
- **只校验 `Host`，不校验 `Origin`** —— 挡不住 `https://evil.com` 直打 `127.0.0.1:3001`：那条请求的
  `Host` 正是本机地址，判据通过。
- **把来源守卫整体并进 `corsPolicy`（或干脆删掉本层，只留 #625 的判定）** —— 落选：两层的判据
  服务不同形态，合并必然要在「本机可达」与「白名单跨机」之间二选一。只留 #625 则 rebinding
  漏（同源判据在 `evil.com` 解析到 127.0.0.1 时成立），已用例固定该差异。
- **给本机 API 加凭据（强制 `SATI_DISABLE_LOCAL_AUTH=0` 登录）** —— 把「本机就是用户本人」的产品
  前提推翻，代价是整个 UI 加登录墙；而威胁模型里**本机进程**本来就不在防护范围（它能直接读文件），
  要挡的只有「外部网页」这条非用户通道。守卫的粒度正好匹配威胁模型。
- **逐面给 `/api` 路由挂来源判定** —— 又回到「安全性依赖每条路由都记得挂」的分散事实（上一批刚把
  这种结构改掉）；全局中间件 + WebSocket 握手两处接线，天然覆盖新加的面。
- **`git.js` 只补 `validateGitRepository`，不改 root 来源** —— 挡不住 `/file-with-diff`：目标目录
  只要是 git 工作树，校验就通过，而它是不是**已登记的工作区**从来没被问过。
- **`taskmaster.js` 只做 `fileName` 校验，保留 root 推导与 `shell: true`** —— `fileName` 收口只
  关掉「路径穿越」这一条；`add-task` 的 `prompt` 进 shell 仍是命令注入，root 由请求方选仍能写到
  项目外。三处都收口才对得上「写 + CLI 副作用面」的定性。
- **保留 `isSymbolicLink()` 作为「便宜的保险」** —— 它覆盖的情形不存在（`lstat` 的类型判定已覆盖），
  留下来会让读者以为有它兜着的情形，反而掩盖真实判据。
- **把来源守卫做成可配置开关（默认关）** —— 默认关等于没做；需要例外的是**部署形态**（自定义域名 /
  LAN），那用一个显式名单 `SATI_TRUSTED_HOSTS` 表达，而不是把整层关掉。

## Consequences

- **换来**：三条缺口同批闭合（外加一处顺带修复的既有路径编码缺陷）。判据四份，均做过负控制
  （回退后实测转红）——
  `ui/server/routes/git.test.js`（18 例：临时 app home 里登记工作区，未注册的 git 工作树读不出
  `CLASSIFIED-CANARY`、home 自身是工作树时 `general`/home 也读不出 `server-token`、已注册工作区
  的 `/file-with-diff` 照常返回、非 ASCII 路径按原名返回；把 root 退回旧语义 → 8 例转红，含两条
  泄漏判据；把 `core.quotepath=false` 摘掉 → 非 ASCII 那条转红，实测收到
  `"\"/344/270/223…\""`）、
  `ui/server/routes/taskmaster.test.js`（15 例：未注册/短横线/app home 的 6 个面回 404/403、
  `fileName` 穿越回 400 且 `escaped.txt` 不落盘、接线契约与「文件里没有 `shell: true`」；
  回退守卫 → 6 例转红，回退文件名校验 → 5 例转红）、
  `ui/server/middleware/localOriginGuard.test.js`（40 例：判据表 + 真实 express，公网来源与
  rebinding 403、无 `Origin` 与 dev 形态放行；`enabled: false` 时跨站请求确实进得来——反向证明
  判据不是恒真；外加 2 例固定与 `corsPolicy` 的分层差异）、
  `ui/server/routes/project-files.root-guard.test.js`（新增路由表自校验：用换参数名的假面实测
  能抓出扫描漏检）。浏览器实测另覆盖：应用同源可用（文件树 / Git 面板 / 变更文件点开读出内容）、
  General 在文件树与源代码管理都得到可区分文案、`Host: evil.com` 与 `Origin: https://evil.com`
  经 `curl` 双双 403、沙箱 iframe（`Origin: null`）的 `fetch` 与 WebSocket 双拒。
- **付出（明示）**：
  - 非本机名部署需配置：UI 经**自定义域名**或**未列出的主机名**访问时，API 会回 403
    `UNTRUSTED_REQUEST_ORIGIN`，须把该主机名加进 `SATI_TRUSTED_HOSTS`。回环、私有地址字面量、
    `os.hostname()`/`.local` 无需配置（MAC 上的 LAN 直连因此照常可用）。
  - 现有两个环境变量是**两个轴**，容易混：`SATI_ALLOWED_ORIGINS`（#625）登记的是**来源 Origin**，
    `SATI_TRUSTED_HOSTS`（本层）登记的是**被当作本机可达的主机名**；跨机部署通常要配前者，而经
    自定义域名访问本机 UI 时两个都可能要配。
  - `general` 的 git 面板从「不是 git 仓库」的提示变为「该路径不可用于文件操作」（两者都是拒绝，
    文案不同）；未注册 id 的 git 面从「解析出的任意路径」变为「Project not found」。
  - WebSocket 握手被来源判据拒绝时只留一行 `[WARN] WebSocket handshake rejected` 日志。
- **未覆盖（明示）**：
  - **本机其它端口的页面仍可调用本机 API**（见上文「边界」）：这是有意的，代价是「本机进程级
    信任」不在防护内。
  - **Windows 语义**未在本机执行：`C:\` / UNC / 大小写不敏感卷的 `Host` 与路径判定；`extractHostname`
    对 IPv6 与端口的分支在 posix 上测过，Windows 的 `Host` 形态未验。
  - **真实 task-master CLI 的端到端**未跑（会走 `npx` 拉包）：去掉 `shell: true` 后判据只覆盖到
    「起 CLI 之前」的拒绝路径与源码静态断言；`init` / `add-task` / `parse-prd` 的实际调用语义
    （含 Windows 下 `npx.cmd` 那条 shim 路径）未实测。
  - **托管部署（`IS_PLATFORM`）与 Electron 生产壳**未跑：守卫在这两种形态下靠 `VITE_IS_PLATFORM`
    与「主进程 fetch 无 `Origin`」的推理而非实测；Electron 渲染进程加载的是
    `http://127.0.0.1:<port>/`（同源，浏览器实测覆盖了同源路径），但未在真实 Electron 里复跑。
  - **`pnpm dev`（Vite 5173 → API 3001）未实跑**：`changeOrigin: true` 的依据是读 vite 源码
    （`dist/node/chunks/node.js:19375-19378`）+ 用原生 `http` 客户端模拟该形态（`Host:
    localhost:3001` + `Origin: http://127.0.0.1:5173` → 放行，已进判据表），未真起 Vite。
  - **极端的引号/换行文件名**仍会被 git 加引号（`core.quotepath=false` 只关掉非 ASCII 转义），
    本次未处理——本机工作区的形态已覆盖。
  - **gateway（`sati server`，19789）与 IM 渠道面**不在本守卫范围内：它们的鉴权/来源判定各自独立，
    本次未触及。

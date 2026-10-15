# Agent Note: 项目文件 API 的 root 只认项目注册表

Status: implemented

## Problem

`ui/server/routes/project-files.js`、`project-preview.js`、`project-uploads.js` 的项目面一律用
`extractProjectDirectory(projectName)` 求 root，而这个函数的三条分支都不校验「登记」：

- 绝对路径**原样透传**（`ui/server/projects.js`）；
- `-Users-foo` 短横线解码：不校验存在性，也不校验是否注册；
- `directoryCache`：由 `getProjects()` 填充的**展示层**缓存，且会被上述绝对路径分支写入。

拿到 root 之后才做的「包含性检查」是在**请求方选定的边界**上做的，因此不构成边界。后果不是
越权读某个项目，而是把任意路径当项目根：本机部署默认免登录（本地 `authenticateToken` 在
`DISABLE_LOCAL_AUTH`/平台模式下放行），任何能访问 `127.0.0.1` 的页面都能借
`GET /api/projects/<任意路径>/file?filePath=…` 读盘、用 `PUT` 写盘、用 `/download` 打包目录。

要害是 app home：`~/.sati` 下就放着 `server-token`（服务访问令牌）与 `sati.yaml`（含 API key 的
配置），而 `general` 这个虚拟工作区的 root 恰好就是 app home。

## Decision

**授权来源只有一个：项目注册表。** 新增两层件，并把 13 个项目面接到同一实例上（`project-files.js`
5 条、`project-preview.js` 6 条、`project-uploads.js` 2 条；该文件第 3 条 `upload-images` 按设计豁免，
理由见「付出」）。

- `ui/server/services/projectRegistration.js`——`resolveRegisteredProject(name, pilotHome)` 只接受
  「`<app home>/projects/<id>/.cwd` 标记精确命中」或「能被 legacy 编码反推且真实存在的目录」；
  登记目录与 `.cwd` 都必须是**真实文件/目录**（软链可把标记引到注册表之外，一律不认）；每次访问
  重新落盘读取，不缓存（登记会在运行中被改指/删除）。
- `ui/server/middleware/projectFilesystem.js`——root 与 app home **父子两个方向都拒**，命中回 403
  `PROJECT_PATH_FORBIDDEN`；判定跑两遍（词法 + `realpath` 规范化后），以覆盖软链与大小写别名；
  未注册/登记失效/工作区已消失回 404 `PROJECT_NOT_FOUND`。通过后把 root 挂到 `req.projectRoot`。
- 处理器一律改用 `req.projectRoot`；`/files` 的短横线解码兜底（`projectName.replace(/-/g,'/')`）删除。
  处理器**不再重复判空** `req.projectRoot`——守卫要么注入 root、要么已经回了 403/404，这些
  `if (!projectRoot) return 404` 是死分支；「每个项目面都挂守卫」由接线契约测试独立钉住，
  不变量不在处理器里重复表达。`/file` 读写两面的包含性检查也改为复用
  `services/filesystem.js` 的 `validatePathInProject`（与 `project-uploads.js` 同一判据，
  语义与错误文案不变）；守卫自身的重叠判定抽成 `utils/pathSafety.js` 的 `pathsOverlap`。
- **聊天附件面放行 app home 重叠**（评审修正）：`project-uploads.js` 的 `/upload-attachments`
  用同一守卫但带 `{ allowAppHomeOverlap: true }`。重叠判定要防的是 app home 里的 `server-token`
  与 `sati.yaml` 被读被改，而该面从不解析请求方给的路径，只在注册表 root 下写服务端构造的
  `.tmp/chat-attachments/<ts>-<rand>/` 目标，够不到那两个文件。不放行则 General（root 即 app home）
  的附件上传整条 403——那是本批唯一会**打断正常使用**的退化（决策记录初稿只写了「文件标签页变空」，
  是漏报）。放行的面由测试反向钉住「只有这一个」。
- **上传处理器改为 fail-loud**（评审修正）：`services/uploads.js` 缺 `req.projectRoot` 时直接回
  500 `PROJECT_ROOT_REQUIRED`，不再回退到按 `projectName` 推导（上游同一改法：注入 `resolveProject`，
  未经守卫授权即抛）。原先的兜底把「忘了挂守卫」变成静默恢复旧行为，与本批的安全性质直接冲突。
- **注册表补 legacy home 回退**（评审修正）：`<app home>/projects` 不可读时回退
  `~/.pilotdeck/projects`，与 `src/web/server/listProjects.ts`（侧边栏项目清单）同一条规则；
  否则升级用户的症状是「项目列得出来、每个文件面都 404」。
- **403 与「项目为空」在 UI 上可区分**（评审修正）：`useFileTreeData` 暴露 `unavailable`
  （仅 403 置位），`FilesV2` 渲染独立的 `fileTree.unavailable` 文案。此前两者都渲染
  「该项目为空。」——面板在断言一个错误事实（铁律 11「降级但不静默」）。
- 错误体用结构化形状 `{ error: { code, message } }`（与 `hookTrust`/`kanban`/`knowledgeDrafts`
  等较新路由一致），使「设计上不可用」（403）与「不存在」（404）可被消费方区分。

`general` 解析为 app home 本身，于是被重叠判定拒掉——这是**有意的行为变更**：General 工作区的
「文件」标签页从此取不到文件树（`useFileTreeData` 在 `!response.ok` 时置空列表并记日志），
换来的是 app home 不再可读写。

## Alternatives considered

- **给「危险路径」列黑名单（`/etc`、`~/.sati` …）** —— 枚举是无穷的（父目录、软链、大小写别名、
  每一层中间目录都能当跳板），漏一个就等于没做；注册表是白名单，天然闭包。
- **保留 `directoryCache`，只是在命中前校验一次** —— 该缓存本身就被绝对路径分支**写入**，把请求
  参数当可信来源；只能改成「缓存里存的也必须先过注册表」，那就等于本方案，缓存退化为纯性能件。
- **保留绝对路径入参（很多调用方传工作区绝对路径）** —— 保留，但改为「须与某条登记精确等值」：
  合法调用方（前端传 `projectRoot`）不受影响，而未注册路径不再能借绝对路径形态进入。
- **放过 `general`，让它继续以 app home 为 root** —— 等于把 `server-token` 与配置留在文件 API 的
  可达面内；上游同一改动同样是拒绝而非放行。产品上若确需 General 有文件工作区，应给它一个
  专用目录并登记，而不是开在 app home 上。
- **把 `git.js` / `taskmaster.js` / `token-usage.js` 一并挂守卫** —— 不同路由族、语义不同：
  `git` 含写操作（checkout/stage），`taskmaster` 会起 `task-master` CLI 进程，`project-sessions`
  与 `token-usage` 读的是**会话元数据**而不是文件内容（后者若挂守卫，General 的会话列表会直接
  坏掉——General 的会话就存在 app home 下）。本次因此只收口项目文件路由族，范围与上游一致。
  ⚠️ 后经代码审查更正：`git.js` 的 `/file-with-diff`、`/diff` 等面**本身就在读文件内容**，此前
  把它归为「非文件内容面」是错的；`taskmaster.js` 更含写入与 CLI 副作用。二者已按下面「未覆盖」
  逐条记名，不能算作「已按边界排除」。
- **让 General 的聊天附件改为「不支持」（保留 403）** —— 需要产品决定 + UI 可区分提示 + i18n，
  且直接砍掉一个原本可用的面；本次选择放行重叠判定：代价仅是上传落到 `~/.sati/.tmp/`（与改动前
  行为一致），而路径仍由服务端构造、root 仍只来自注册表。
- **给 General 一个专用工作区目录** —— 会改动产品语义（General 的会话与记忆都在 app home 下），
  超出本批边界；留作「若确需 General 有文件工作区，应这样做」。
- **给守卫传 `env` 之外的注入点以便测试** —— 已用 `{ env }` 参数覆盖（测试注入 `SATI_HOME`），
  不再额外引入依赖注入层。legacy home 回退的判据同样不引入注入点：`os.homedir()` 在 POSIX 下
  跟随 `HOME`，测试改 `process.env.HOME` 即可，无需 mock 模块。

## Consequences

- **换来**：任意路径不再能当项目根；app home 与其父/子目录在**项目文件路由族内**不可达（该限定
  的理由见下面「未覆盖」对 `git.js` 的说明——它不是全局性质）。判据五份——
  `ui/server/services/projectRegistration.test.js`（授权来源 + legacy home 回退）、
  `ui/server/middleware/projectFilesystem.test.js`（重叠拒绝，含软链与大小写别名；以及放行重叠
  时仍拒未注册）、`ui/server/routes/project-files.root-guard.test.js`（真实 router 端到端 + 接线
  契约：每个项目面都必须挂同一守卫、只有聊天附件面用放行重叠的守卫、豁免项须显式登记、条数写死
  避免「解析为空 = 断言恒真」）、`ui/server/services/uploads.test.js`（缺授权 root 时 fail-loud）、
  `ui/src/components/file-tree/hooks/useFileTreeData.test.ts`（403 与空项目可区分）。
  均已负控制实测：摘掉 `realpath` 那对判定 → 软链与大小写两条转红；回退整批改动 → 越权读
  `server-token` 由 403 变 200；把聊天附件面换回严格守卫 → 2 条转红；上传处理器回退到兜底版本 →
  1 条转红；去掉 legacy 回退 → 1 条转红；钩子不标 `unavailable` → 1 条转红。
- **付出（明示）**：General 工作区的「文件」标签页取不到文件树——这是本批唯一的用户可见功能退化，
  属有意取舍；面板现在显示 `fileTree.unavailable`（「该工作区不允许文件访问」）而不是
  「该项目为空。」，两者可区分。`ui/server/routes/project-uploads.js` 的 `upload-images` 按设计
  不挂守卫（只用 `req.user.id` 与临时目录，从不解析项目 root，也就没有待授权的 root；它同时没有
  任何源码消费方），该豁免在接线契约测试里显式登记，并有一条反向断言防止「豁免烂掉」。
- **未覆盖（明示）**：
  - `git.js` 自己的文件内容面（`/file-with-diff`、`/diff`、`/commit-diff` 等）仍走
    `getActualProjectPath()` → `extractProjectDirectory`（绝对路径透传 + 短横线解码），而
    `validateProjectPath`（`git.js:90`）只拒空值、NUL、非绝对与根目录：`GET
    /api/git/file-with-diff?project=<任意路径>&file=…` 在目标自身是 git 工作树时可逐字读出树内
    任意文件（例如 `~` 是 dotfiles 仓库时即含 app home）。
    另外 `/checkout`（`ui/server/routes/git.js:720`）与 `/create-branch`（`:742`）是唯二**没有**
    `validateGitRepository` 的路由。故「app home 不可达」应表述为「项目文件路由族内不可达」。
  - `taskmaster.js` 不只是文件内容面，而是**任意路径写 + CLI 副作用**面：`projectPath` 同样由
    短横线解码得出，而 `fileName` / `prdFile` 直接来自 `req.body` 且未做穿越校验
    （`path.join(projectPath, ".taskmaster", "docs", fileName)`——读 `taskmaster.js:577`、
    写 `:718` → `:722` 的 `fsPromises.writeFile`）；这些路由还会以 `shell: true` 起
    `task-master init` / `task-master-ai add-task|set-status|update-task|parse-prd`
    （`:326/:414/:479/:520/:606`，`shell` 见 `:328/:414/:479/:520/:606`）。危害等级高于只读面。
  - 注册本身就是授权来源，而 `POST /create-workspace` 可把任意现有目录变成「已注册」（本机默认
    免登录：`ui/server/middleware/auth.js:26`，`IS_PLATFORM || DISABLE_LOCAL_AUTH` 即放行；
    `ui/server/index.js:80` 的 `cors()` 默认放行任意 origin），随后即可读写打包：本批收窄的是
    「root 由请求参数推导」，**没有**抬高认证边界；origin/Host 守卫仍是独立议题。
  - `project-preview.js` 的预览面已收口，但预览凭据与 `authenticateProjectPreview` 的交互
    **没有自动化用例**——只在结构层面覆盖；手工浏览器验证已跑通（真实 UI：`POST /preview-token`
    200 → 带 `?token=` 取 `preview/*` 200 且正文正确、`general` 的 `preview-token` 403），下次改动
    该面仍需手工复验。

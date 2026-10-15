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

**授权来源只有一个：项目注册表。** 新增两层件，并把 9 个项目面接到同一实例上：

- `ui/server/services/projectRegistration.js`——`resolveRegisteredProject(name, pilotHome)` 只接受
  「`<app home>/projects/<id>/.cwd` 标记精确命中」或「能被 legacy 编码反推且真实存在的目录」；
  登记目录与 `.cwd` 都必须是**真实文件/目录**（软链可把标记引到注册表之外，一律不认）；每次访问
  重新落盘读取，不缓存（登记会在运行中被改指/删除）。
- `ui/server/middleware/projectFilesystem.js`——root 与 app home **父子两个方向都拒**，命中回 403
  `PROJECT_PATH_FORBIDDEN`；判定跑两遍（词法 + `realpath` 规范化后），以覆盖软链与大小写别名；
  未注册/登记失效/工作区已消失回 404 `PROJECT_NOT_FOUND`。通过后把 root 挂到 `req.projectRoot`。
- 处理器一律改用 `req.projectRoot`；`/files` 的短横线解码兜底（`projectName.replace(/-/g,'/')`）删除。
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
- **把 `git.js` / `taskmaster.js` / `token-usage.js` 一并挂守卫** —— 不同路由族、语义不同：`git`
  含写操作（checkout/stage），`taskmaster` 会起 `task-master` CLI 进程，`project-sessions` 与
  `token-usage` 读的是**会话元数据**而不是文件内容。最后一类若挂上守卫，General 的会话列表会
  直接坏掉（General 的会话就存在 app home 下），故本次明确以「文件内容面」为界，与上游同一
  边界；`git`/`taskmaster` 的文件内容可达面留作独立议题（需逐路由审查写操作与 CLI 副作用）。
- **给守卫传 `env` 之外的注入点以便测试** —— 已用 `{ env }` 参数覆盖（测试注入 `SATI_HOME`），
  不再额外引入依赖注入层。

## Consequences

- **换来**：任意路径不再能当项目根；app home 与其父/子目录在文件内容面上不可达。判据三份——
  `ui/server/services/projectRegistration.test.js`（授权来源）、
  `ui/server/middleware/projectFilesystem.test.js`（重叠拒绝，含软链与大小写别名）、
  `ui/server/routes/project-files.root-guard.test.js`（真实 router 端到端 + 接线契约：每个项目面
  都必须挂同一守卫、豁免项须显式登记、条数写死避免「解析为空 = 断言恒真」）。均已负控制实测：
  摘掉 `realpath` 那对判定 → 软链与大小写两条转红；回退整批改动 → 越权读 `server-token` 由 403 变 200。
- **付出（明示）**：General 工作区的文件标签页变为空列表——这是本次唯一的用户可见功能退化，
  属有意取舍；`ui/server/routes/project-uploads.js` 的 `upload-images` 按设计不挂守卫（只用
  `req.user.id` 与临时目录，从不解析项目 root，也就没有待授权的 root；它同时没有任何源码消费方），
  该豁免在接线契约测试里显式登记，并有一条反向断言防止「豁免烂掉」。
- **未覆盖（明示）**：`git.js` / `taskmaster.js` 的文件内容可达面未收口（见上）；`project-preview.js`
  的预览面已收口，但预览凭据与 `authenticateProjectPreview` 的交互只在结构层面覆盖，未做端到端
  凭据路径测试。

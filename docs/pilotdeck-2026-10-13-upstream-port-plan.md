# Sati × PilotDeck 引入方案（v2026.10.13-r2 批次）

Status: implemented（部分——P0-1 / P0-2 / P1-1 已落地，见「十三、落地情况」；其余未开工）

范围基线：上游 `OpenBMB/PilotDeck` 在 **PR #599（`cd52c9af`，2026-09-18）之后**的增量
——评估时点上游 tag **`v2026.10.13-r2`**（目标提交 `783499f`，2026-10-13），覆盖 PR #600–#647；
并附该 tag 之后合并的 #648 / #649（2026-10-15）
候选范围：**34 个实质 PR + 5 个 dependabot CI PR**（#553–#556、#582）
基准提交：Sati `main`；上游 force-push 无法 `git merge`，只能手工语义移植 ⇒ **成本在「判定」不在「搬」**
前序评估：`docs/pilotdeck-2026-09-upstream-port-plan.md`（2026-09-11 批次）、
`docs/pilotdeck-2026-09-19-upstream-port-plan.md`（#599）、`docs/pilotdeck-2026-10-upstream-port-plan.md`（10-06 批次）
交付形态：待定——落地时每项一条分支 + 一个 PR（AGENTS.md：main 受保护）

---

## 一、基线认定：上次引入到哪里

| 文档 | 声明边界 | 状态 |
|---|---|---|
| `pilotdeck-2026-09-upstream-port-plan.md` | 上游 2026-09-11 之后合并的 PR | implemented（P1–P6） |
| `pilotdeck-2026-09-19-upstream-port-plan.md` | 上游 #599（2026-09-18） | implemented（P0/P1/P3） |
| `pilotdeck-2026-10-upstream-port-plan.md` | 「上游 `main` @ 2026-10-06，含 PR #600–#632」 | implemented（批次 A–E，PR #610） |

**一处需要更正的边界**：第三份文档自述覆盖「#600–#632」，但它写的评估时点是 **2026-10-06**，
而 **#620 / #621 / #622 / #626 / #635 实际合并于 2026-10-08 与 10-09**，落在该时点之后。
实测也印证这个错位：`2026-10-10-write-path-symlink-escape.md`（#621/#635）与
`2026-10-10-token-log-redaction.md`（#622）是 10-10 单独补做的，而 **#620 与 #626 至今未做**
（见 P0-1、P1-1）。⇒ **已消耗边界必须以逐项实测为准，不能只读那行声明。**

本文件即 `v2026.10.13-r2` 边界的评估结论。

## 二、上游 delta 清单

该窗口内上游共合并 39 个 PR：34 个实质改动 + 5 个 dependabot GitHub Actions 版本升级。
实质改动按性质归并如下（明细见第三、四、五、七节）：

| 归并 | PR |
|---|---|
| 会话/配置/工具/定时任务核心 | #597 #600 #602 #612 #614 #626 #628 |
| UI 与工作区 | #603 #604 #613 #620 #622 |
| 桌面壳、外观与打包 | #605 #606 #611 #619 #627 #629 #631 #632 #634 |
| 安全、SDK、检查点 | #621 #633 #635 #636 |
| Computer Use | #638 #639 #643 |
| 技能页、搜索、用量统计 | #641 #646 #647 |
| 文档 | #649 |
| 项目文件 API 安全（tag 之后） | #648 |

## 三、判定总览

| 判定 | PR | 一句话 |
|---|---|---|
| **P0 立刻修** | #620 | 工作区创建失败会递归删除已存在的父目录 |
| **P0 立刻修** | #648 | 项目文件 API 信任请求推导的 root，可越权读写删 |
| **P1 真缺陷、改动面小** | #626 #647(错误可读化) #638/#643(切片) | 一行修复 / 纯函数 / 纯 TS 切片 |
| **P1 真缺陷、需适配** | #647(凭证隔离) #646(服务端切片) #631 #641 | 结构改动，须对接 Sati 官有形态 |
| **P2 值得做、需权衡** | #611(外观持久化) #604 #636(切片) #613(3 小补丁) | 见第六节 |
| **已覆盖、不必再做** | #597 #600 #602 #612 #614 #621 #622 #628 #635 #605(托盘半) #606 #603(缺陷半) #613(主体) | Sati 已有等价或更强的实现 |
| **不适用** | #605(安装器半) #624 #627 #629 #631(外观半) #632 #633 #634 #638 #639 #643 | 目标模块不存在 / 平台不维护 / 与 Sati 结构事实不相容 |
| **无移植对象** | #649 #553–#556 #582 | 上游 README 公告；Sati 自有 CI |

---

## 四、P0（高危缺陷，建议立刻做）

### P0-1 #620 工作区创建失败会递归删除已存在的父目录

`fix(ui): preserve workspace parents on missing token`（2026-10-08，+123/−13，2 文件）

**缺陷面（Sati 等价存在，已复核）**

`ui/server/routes/projects.js` 的 `POST /create-workspace` 与 `GET /clone-progress` 的顺序是
**先建目录、再查凭据、查不到就把该目录递归删掉**：

| 位置 | 行为 |
|---|---|
| `projects.js:375` | `await fs.mkdir(absolutePath, { recursive: true })` |
| `projects.js:387` | `githubTokenId` 查不到 ⇒ `await fs.rm(absolutePath, { recursive: true, force: true })` |
| `projects.js:508` / `:514` | `clone-progress` 的同一形态 |

`absolutePath` 来自 `validation.resolvedPath`，而 `workspaceType: "new"` **并不要求路径事先不存在**
——`validateWorkspacePath`（`projects.js:82`）只拒系统关键目录。于是「路径填已存在的 `~/dev` +
一个不存在的 `githubTokenId` + 带 `githubUrl`」会递归删除整棵 `~/dev`。这是**数据毁灭路径**，
不是权限边界问题。

**上游修法**：把凭据解析提到 `mkdir` **之前**，查不到就直接 404/错误返回，并**删掉 `fs.rm` 清理**
（此时尚未创建任何东西，无需清理）。上游附 3 条回归用例。

**落地建议**

- 改动面：`ui/server/routes/projects.js` 两处块搬移 + 删除两处 `fs.rm`；新增
  `ui/server/routes/projects.workspace-cleanup.test.js`（上游 108 行可直接用，须核对 Sati 侧
  `../database/db.js` 的真实相对路径）。
- Sati 官有耦合点：Sati 已把 upload/preview 路由拆到 `ui/server/routes/project-*.js`，但这两条
  clone 路径仍留在 `projects.js`，落点唯一。
- 风险：低（不新增依赖、不改契约、不动前端）。
- 验证：新增用例三条必过（父目录兄弟文件仍在 / 新路径不被创建 / 404 形状不变）；手工复现一次
  「已存在父目录 + 不存在的 `githubTokenId`」，确认父目录完好。
- **顺带闭环**：`docs/notes/implemented/2026-10-10-token-log-redaction.md:29` 把「上游 workspace
  token cleanup 语义未能定位、本项目是否有等价问题**未核验**」挂在那里。现已核验：**有，且完全等价**。
  该 note 的「未核验」标注应在落地时改为已闭环。

### P0-2 #648 项目文件 API 拒绝未注册 root

`fix(web): reject unregistered roots in project file APIs`（2026-10-15，+361/−45，6 文件）

**缺陷面（Sati 等价存在，已复核）**

`ui/server/routes/project-files.js` 的四个端点（`:168` / `:227` / `:273` / `:316`）都以
`extractProjectDirectory(projectName)` 求 root，紧接着在这个**由请求推导出来的 root** 上做包含性
检查——因为 root 本身是攻击者选的，这道检查不构成边界。而 `extractProjectDirectory`
（`ui/server/projects.js:348`）的两条分支都不做注册校验：

| 位置 | 行为 |
|---|---|
| `projects.js:352-355` | `path.isAbsolute(projectName)` ⇒ **原样返回该绝对路径** |
| `projects.js:366-371` | `-` 开头 ⇒ 旧式 dash 解码（`-Users-foo` → `/Users/foo`），**不校验存在性与注册状态** |
| `projects.js:59-63` | `directoryCache` / `rememberProjectDirectory` 是被信任的展示层缓存 |

上游明确点出「不得信任 `getProjects()` 填充的展示层缓存」，正是此处。

**上游修法（三块）**

1. 新增「只认已注册项目」的解析：读 `~/.sati/projects/<id>/.cwd` 标记，或按**精确 ID 匹配**；
   注册目录须为真实目录且非软链。
2. 拒绝与 app home 重叠的 root——**父子两个方向都拒**（含 realpath 后再判，堵住父目录旁路）。
3. **删掉文件树那条 path 解码兜底**。

**落地建议**

- 改动面：`ui/server/routes/project-files.js` 改为复用中间件注入的 `req.projectRoot`；新增
  `ui/server/middleware/projectFilesystem.js` + `ui/server/services/projectRegistration.js`
  两个文件；`ui/server/services/uploads.js`（工作区上传）一并对齐。
- Sati 官有耦合点：Sati 已把 `ui/server/index.js` 拆成 routes（上游仍在 `index.js` 内定义
  `requireRealProjectFilesystem`），因此**没有现成的中间件落点**，需按 Sati 的 routes 挂载方式
  新建；命名与路径须改为 `SATI_HOME` / `createProjectId`（`ui/server/utils/pilotPaths.js`）。
  Sati 无 `ui/server/utils/pathSafety.js`，上游用的 `isPathInsideOrEqual` 需一并引入或内联；
  Sati 也无 `isVirtualProjectPath`（`general` 由 `projects.js:282` 的
  `rememberProjectDirectory("general", generalHome)` 表达），该分支需按 Sati 语义重写。
- 风险：中。这是**否认式**改动（原先能通过的请求会被拒），须确认「已注册项目 + 合法绝对路径
  参数 + legacy dash ID」三类合法路径仍然通过，否则会打断既有用户的项目打开流程。
- 验证：移植上游 4 份新测试（未认证拒绝 / 未注册绝对与 dash root 拒绝 / 二进制下载与读写的
  拒绝 / app home 父子 root 拒绝 / 已移除注册拒绝 / 合法操作仍成功），另加负控制——临时摘掉
  注册校验，确认「未注册 root」用例转红。

---

## 五、P1（真实缺陷，建议本批引入）

### P1-1 #626 `edit_file` 未按字面量写 `new_string`

`fix(tool): write edit_file new_string literally`（2026-10-08，+64/−1，2 文件）

**缺陷面（Sati 存在，已复核）**：`src/tool/builtin/editFile.ts:207` 仍是

```ts
: content.replace(actualOldString, normalizedNew);
```

字符串替换会把 `new_string` 里的 `$$` / `$&` / `` $` `` / `$'` 当替换模式展开，写进文件的
不是用户给的字符串（`replace_all` 分支用的是 `split().join`，本来就安全，未受影响）。
全 `src/tool/builtin/` 仅此一处该形态，无扩散。

**修法**：改用函数替换器 `content.replace(actualOldString, () => normalizedNew)`。

**落地建议**

- 改动面：`editFile.ts:207` 一行 + 一行注释；新增 `tests/tool/edit-file-literal-replacement.spec.ts`
  （`.spec.ts` 不受 `.gitignore` 的 `*.test.ts` 豁免影响，无需 `git add -f`）。
- 风险：极低。**不触 `inputSchema`**（`EditFileInput` 不变）⇒ 按 AGENTS.md 规则 6 **不会**使
  llm-replay fixture 失配。
- 验证：上游那 10 个用例（`$$HOME` / `$$E=mc^2$$` / `IFS=$'\n'` / `` $` `` / 正则 `\$&`，各含
  `replace_all` 两态）。
- **注意编号撞车**：Sati 议题 #626 是「URL 票据载体」（`docs/notes/implemented/2026-10-15-url-ticket-carriers.md`），
  与上游 PR #626 无关，勿按编号判「已覆盖」。

### P1-2 #647 搜索连接错误的可读化与脱敏（可直接移植）

`fix(search): preserve provider credentials and show readable API errors`（2026-10-13，+729/−160，16 文件）

**缺陷面（Sati 部分覆盖）**：脱敏原语已在 `src/pilot/config/webSearchAdapter.ts:184-190`
（明文 / `encodeURIComponent` / `URLSearchParams` 三形态，与上游新测试期望一致），但
`ui/server/routes/config.js:1151-1157` 仍走 `String(raw.error || raw.msg || ...)`——GLM 风格的
`{error:{code,message}}` 会显示成 `[object Object]`；`:1155` 只认 `typeof raw.error === "string"`；
`:1172-1174` 的 `code=` 分支未脱敏。

**修法**：移植上游 `formatWebSearchApiError` + `hasApiError`（纯函数，无结构依赖），三处返回改走
`redactSearchError(formatWebSearchApiError(...), trimmedKey)`。

**落地建议**

- 改动面：`ui/server/routes/config.js` 新增两个函数并改三处返回；`config.test.js` 加上游 8 个
  用例（含非 JSON 回退、编码 key 遮蔽）。
- **适配点（必须复核）**：上游把 `hasApiError` 提到 additional-results 分支**之前**，会让
  exa/bocha 等「响应里带 `error` 字段但成功」的情形被改判。Sati 的
  `additionalSearchResults` 语义需先对齐，否则这是**引缺陷**而非修缺陷。
- 风险：低。不触 `inputSchema`。

### P1-3 #647 每-provider 凭证隔离（需适配移植）

**缺陷面（Sati 未覆盖，是真缺陷）**：切换 provider 即丢用户密钥。
`ui/src/components/settings/view/agentSearch/utils/webSearchConfig.ts:48-58` 的
`webSearchConfigForProvider` 只返回 `{enabled?, provider, endpoint?(仅 glm)}`——切 provider 时
`apiKey` / `customProvider` / `searchEngine` / 非 glm 的 `endpoint` 全部消失。

**上游机制**

| 机制 | 内容 |
|---|---|
| M1 结构 | 新增 `src/pilot/config/webSearchConfig.ts`，配置改为 `providers.<provider>` 槽位；`types.ts` 的 flat 定义改 re-export |
| M2 优先级 | `providers?.[provider]` 存在即整槽优先（空对象也遮蔽 legacy）；否则仅当前 provider 回落 flat |
| M3 迁移 | `migrateWebSearchProviderConfigs` 只搬当前 provider 的 legacy 字段，**不跨 provider 复制**、幂等 |
| M4 保存隔离 | 不相关设置保存不得搬动别家凭证；`webSearchSecretSource` 桥接「表单已迁、磁盘还是 flat」 |
| M5 掩码校验 | 掩码 key 逐槽按各自作用域校验，禁止借用他槽凭证 |
| M6 探测取键 | `/test-web-search` 按 selected provider 取已存 key，并区分「该 provider 无 key」与「活跃 provider 有」 |
| M7 错误可读 | 见 P1-2 |
| M8 运行时同源 | 装配点改走 `resolveWebSearchConfig`，使 UI / 探测 / 运行时三方同源 |

**Sati 现状**：M7 部分覆盖（P1-2）；**M1/M2/M3/M5/M6/M8 未覆盖**；M4 部分覆盖
（`ui/server/services/satiConfig.js:431-446` 的 `preserveMaskedSecrets` 是键名无关的递归重建，
`providers.<p>.apiKey` 天然可覆盖，但缺 `webSearchSecretSource` 桥与
`updateWebSearchProviderConfig`）。

**对旧判断的更正**：Sati 的 provider 枚举与上游**已经一致**（两侧 `WEB_SEARCH_PROVIDERS` 均为 9 项），
这是 2026-10 批次 D（`2026-10-07-web-search-provider-expansion.md`）对齐的结果，**不构成障碍**。

**落地建议**

- M1–M6、M8 应**一起做**：它们共享同一个新模块与同一份数据结构，拆开会留下「结构在、迁移不在」
  或反过来的半态。
- Sati 官有耦合点：① `ui/server` 访问 `src/` **只能经 barrel**（`scripts/check-ui-server-boundary.mjs`
  白名单 + `src/pilot/config/index.ts` 既有导出），新增导出必须走 barrel，不能照抄上游的深路径 import；
  ② Sati 的端点校验比上游松（`parseToolsConfig.ts:294-309` 只查非空串，**无 `new URL` HTTP(S) 校验**，
  上游 `parseProviderConfig` 带）——照搬会给非 URL endpoint 的既有用户引入新的 fatal diagnostic，
  需明确取舍；③ `web_search` 的 `inputSchema` 不变（`searchEngine` 与 `providers` 都是配置面）⇒
  不触发 llm-replay 重录，与批次 D 判断一致。
- 风险：中。改的是配置文件结构 + 保存/迁移路径，误判会**搬动或删除用户已存密钥**——上游那 12 个
  混合配置回归用例正是为此。`ui/server/routes/config.js` 已 1200+ 行，注意 file-size 棘轮。
- 验证：`tests/pilot/config/parseToolsConfig.spec.ts`（补 providers 解析与各自 path 的 fatal 断言）、
  新增 `tests/pilot/config/webSearchConfig.spec.ts`（legacy 归属 / 幂等 / 空槽遮蔽 / 实际请求只用
  选中 provider 的 key）、`ui/server/routes/config.test.js`（raw 与 config 双形态的 12 个混合用例 +
  掩码不得借用他槽凭证 + 切回后重启读回）、`utils/webSearchConfig.spec.ts` 与 `ToolsSection.test.tsx`。

### P1-4 #646 技能页改造的服务端切片（需适配移植）

`feat(ui): redesign skills page as a reading workbench`（2026-10-13，+5296/−1119，23 文件）

该 PR 是「服务端地址化 + 项目上下文一致性两类真缺陷」与「阅读工作台 UI 重写」的混合体。
**Sati 侧 `SkillsV2` 与上游改动前同源起底但已独立分叉**（Sati 2525 行 → 已拆出 `skills/**` 约 1100 行，
含 `BuiltinSkillsNotice` / `ScopeBadge` / 模板元数据），故**不能整 PR 合入**，只摘下列切片。

| 切片 | 上游机制 | Sati 现状（证据） | 判定 |
|---|---|---|---|
| A1 服务端**地址化** | `resolveSkillAddress`（`scope + slug`），legacy path 仅接受与网关列表精确匹配；网关侧解析技能目录 | 服务端仍是 path 分类 `ui/server/routes/skills.js:128`；前端仍传 path `SkillsV2.tsx:156/185/227/486/518`、`skills/import/ImportFromFolder.tsx:451`。**但 Sati 网关侧早已是地址化契约**（`src/extension/skills/types.ts:5`「every operation is addressed by `(scope, slug)`」、`:130` `SkillAddressInput`）——缺的只是 UI→server 这段翻译层 | **适用，高价值** |
| A2 项目上下文一致性守卫 | `isCurrentContext` / `listRequest` / `mounted` / `previousProjectPath`：延迟删除或移动的结果不得替换另一个项目的列表与选中项 | Sati **完全没有**：`SkillsV2.tsx:109` 的 `refresh` 无 requestId，`isCurrentContext` 等全仓零命中 | **适用，高价值** |
| A3 ClawHub publisher | search 解析 owner、新增 `/clawhub/inspect`、`@owner/slug` 装为 `owner--slug` | Sati `SearchResult` 无 `owner`（`SkillsV2.tsx:48`）；服务端无 inspect 端点（`skills.js:482/532`） | **适用，可独立摘取** |
| A4 新增对话框细化 | 跨 tab 保留字段、填充态关闭保护、失败重试、部分批量重试 | Sati `NewSkillModal` 均无；已有 `skills/import/ImportFromFolder.spec.tsx` 可扩 | **适用，低优先** |

**明确不做**

- `ui/server/utils/clawHubCli.js`（`createRequire` 解法）：Sati 已有等价但不同实现
  （`ui/server/utils/clawhub.js:75` `resolveClawhubPath` 的文件系统探测链 + `SATI_CLAWHUB_PATH`），
  且上游解法依赖把 `clawhub` 作为 `ui/package.json` 依赖（Sati 无此依赖），照搬会改变分发形态。
  **只做核验**：确认 Sati 的探测链在 Electron 打包态能命中。
- `SkillConversationContext` + `selectSkill`（技能带入新会话）：Sati 的 composer **无
  `selectedSkills` / `selectSkill`** 前置能力（`useChatComposerState.ts` 全仓零命中），照搬只能交付
  半截特性。若产品确要，应立独立议题先建 composer 技能选择能力。
- `SkillsV2.css`（+1015 行）整包引入：含大量上游设计 token 与类名体系，须随阅读工作台一并按
  Sati 品牌/暗色体系重做。

**阅读工作台（`SkillMarkdown` + `SkillReader` + `/documents` + `/read-document` + 双栏布局）**

判定为**值得引入但须手工改写、分阶段落地**：收益明确，但 Sati 的 `SkillsV2` 已拆分、上游 diff
无法 cherry-pick。依赖零新增（`ui/package.json` 已含 `react-markdown` / `remark-gfm` / `remark-math` /
`rehype-katex` / `yaml`）。建议顺序：先只上 `SkillMarkdown`（只读渲染，风险小）→ 再上 `SkillReader`
（文档选择器 / 目录 / 锚点）→ 最后上双栏布局。

**落地建议（A1–A4）**

- Sati 官有耦合点：① `SkillsV2` 由 `MainAreaV2.tsx:459 → MainContent.tsx:817` 渲染，A2 的
  `onProjectChange` 须经 `MainContent` props 上报，而非上游的 `MainAreaV2.SkillsArea`；
  ② i18n 键**不可照抄上游**（Sati 的 `skillsTab` 命名空间文案与上游不同，上游约 40 个新键），
  须逐键取舍并同时写 `en` + `zh-CN`；③ 表单式编辑（`SkillForm` / `skillDocument.ts`）**必须
  逐字保留** `type: role` 角色技能的 `tools` / `domains` / `omitTools` / `readOnly` / `systemPrompt`，
  否则破坏 `scripts/validate-skills.mjs:169` 的门禁。
- 风险：A1 低（前后端同仓同步改，网关契约不变）；A2 低（纯 UI 状态机）；A3 低-中（依赖
  `clawhub inspect --json` 的真实字段，须真机核对）；阅读工作台 中-高。
- 验证：服务端移植上游三份新测试（`skills.addressing.test.js` / `skills.documents.test.js` /
  `skills.inspect.test.js`，含「陈旧 worktree 路径按身份读成功」「未列出路径 400」「`builtin` 写 403」
  「`../` 与绝对路径 400/403」「>1MB 413」「非法 slug 不调用 CLI」）；浏览器端到端见第九节清单。

### P1-5 #638 / #643 中可脱离 Computer Use 独立摘取的切片

`#638 fix/feat: add built-in Computer Use with managed Cua Driver MCP`（2026-10-10，+2647/−62，65 文件）
`#639`（2026-10-12）、`#643 fix(computer-use): synchronize macOS permissions across web and desktop`
（2026-10-13，+602/−51，18 文件）

**整体判定：不适用（以「移植」计价）**。Sati 中 Computer Use **零对应物**——`standaloneComputerUse.js`、
`scripts/computer-use/`、`scripts/prepare-computer-use.mjs`、`scripts/lib/mac-computer-use.mjs`、
`apps/desktop/src/computerUse.ts`、设置页 computerUse 视图、`ui/server/routes/computer-use.js` 等
**全部不存在**；`ui/shared/computerUse.d.ts` 无；`main.ts` 中 `systemPreferences` / `desktopCapturer`
零命中。整链（第三方 Driver 二进制分发 → 签名/公证 → 原生 GUI 宿主 → 托管式保留 MCP server →
设置页/权限同步）在 Sati 全缺，且其中 macOS 宿主与打包路径依赖**已被 Sati 分叉的构建管线**
（`server-manager.ts` 解 `satiui-bundle.tar`，非上游 `build-runtime.mjs`）。⇒ 这是一次**新子系统开发**，
不是移植。

但下列切片**纯 TS / React、零原生依赖、可直接移植**：

| 切片 | 上游机制 | Sati 落点（已复核） |
|---|---|---|
| S1 **重连不得盲目重放**（最高价值） | `callTool` 先算 `advertisedReplay = readOnlyHint === true \|\| idempotentHint === true`，重连后**在新一代上重新确认**（`mayReplay(await listTools())`），不可重放则抛显式错误「the action may have executed. Observe current state before retrying.」 | `src/mcp/client/connection.ts:168-188` 的 `callWithReconnect` 在 `isSessionExpired` 后**无条件重连并重放**同一次 `fn(client)`；`src/mcp/protocol/types.ts:33` 的 `idempotentHint` **声明了却从未被消费**（仅 `readOnlyHint` 在 `PluginToToolBridge.ts:52` 被读）。补可重放谓词参数即可：`listTools` 恒可重放，`callTool` 按注解 |
| S2 陈旧响应防回退 + 探测失败显式化 | `requestSequence`（自增序号，只有序号仍是最新才 `setStatus`）+ `operationPending` ref；轮询期间有用户操作在飞则跳过轮询；`focus` / `visibilitychange` 补读；失败**不保留旧态** | `ui/src/components/settings/view/integrations/im/hooks/useGatewayStatus.ts:18` 是裸 `setStatus(data)`，`:43` 的定时器与保存/停用动作**并发**（`FeishuChannelSection.tsx:77-84`、`WeComChannelSection.tsx:76-83`），catch 分支只在 `showLoading` 时清状态 ⇒ 后台轮询失败静默保留上一次状态。Sati 已有同款先例可对齐写法：`ui/src/hooks/useSatiConfig.ts:116/276/314-322` 的 `saveSequenceRef` |
| S3 `concurrencySafe` 服务级退出并行批次 | 上游给 server spec 加 `concurrencySafe`（`false` 时只读工具也不进并行批次），贯通 spec 解析 → bridge | `src/mcp/protocol/types.ts:6-27` 的 `SatiMcpServerSpec` 无该字段；`PluginToToolBridge.ts:65` 是 `isConcurrencySafe: () => isReadOnly`。对 Sati 现存的有状态 MCP server（浏览器自动化等）即刻有用 |
| S4 MCP 连接卫生 | `client.onclose`（带 `this.client !== client` 守卫忽略被替换连接的迟到 close）→ 回收 transport；握手异常时 `await client.close()`；扩展「会话过期」判据 | `src/mcp/client/connection.ts` 的 `start` / `recycleTransportAfterTimeout` / `isSessionExpired` |

- 风险：低。不触任何 `inputSchema` ⇒ 无 llm-replay fixture 影响；无协议变更。
- 验证：上游 `tests/mcp/**` 可直接移植（本机 `node --test` 可跑）；S2 走 Vitest。
- **明确不摘**：`probe` 子命令与 `AXIsProcessTrusted()` 的 `UInt8`→布尔序列化修复、
  `resolveMacRuntime` 的签名校验与不可变安装、`writeIcns`——全部锚定不存在的原生组件。
- 另一条**需独立立项、不随本批**：`/api/computer-use` 的 origin / Host / `sec-fetch-site` 守卫
  （含 `trustedProxy.js`）是「本地免登录部署不得被任意网页调用」的通用解法，但适用面是 Sati 既有的
  `/api/gateway`、`/api/config` 等端点，属独立安全议题（Sati 现仅挂 `cors()`，无 `trust set`）。

### P1-6 #631 模型删除的服务端原子引用改写（需适配移植）

`fix: repair model removal and modernize appearance settings`（2026-10-02，+3612/−2787，106 文件）

**缺口（已在 `pilotdeck-2026-10-upstream-port-plan.md` §四登记为已知缺口）**：Sati 是「写盘时校验、
只拦不修」——`ui/server/services/satiConfig.js` 的 `validateSatiConfig` 对悬空引用报 error（`:293`
`modelRef`、`:299-303` `agent.subagents.default`、`:313-334` router 各槽、`:376-381` `memory.model`），
由 `ui/server/routes/config.js:265/444/644` 调用。删掉被 `agent.model` 引用的 provider 时，客户端
只清 subagent 默认（`ui/src/components/settings/view/modelPool/utils/providerRefs.ts:14/23/38`，
接线在 `ModelsSection.tsx:34-37/50/72`、`ProviderCard.tsx:85-88`），保存即被拦下——**无替换选择、
无预览、无原子修复**。上游的 `collectReferenceSlots()` + `planModelRemoval()`（返回完整下一份配置 +
`changes` 预览，或带 `blocked.code` 的阻塞计划）+ `POST /api/config/model-removal`（`dryRun` +
`baseRevision` 乐观并发）正好补这块。Sati 侧 `GET /model-references` 与 `POST /model-removal`
**均不存在**（`ui/server/routes/config.js` 端点仅 `/validate`、`/model-windows`、`/provider`、
`/models`、`/test-connection`、`/web-search`、`/open` 等）。

**落地建议**：**只移服务端语义，不搬上游客户端**（上游外观部分见第七节）。

- Sati 官有耦合点：① 客户端 `providerRefs.ts` 已承担部分引用改写（subagent 默认 + provider 重命名），
  再上服务端权威改写会**双写**同一批引用——须先定归属（建议服务端为唯一改写方，客户端退化为预览）；
  ② Sati 写盘走 `updateSatiConfig(mutate, { paths })` 外科化 + revision CAS
  （`2026-10-07-config-surgical-write-and-read-consistency.md`），与上游 `withPilotDeckConfigWrite`
  形态不同，须对接 Sati 的 CAS 而非照搬；③ 必须保证「上游计划已修复后」`validateSatiConfig` 仍能通过
  （两侧一致性要测）。
- 风险：中。引用面穷尽性易漏（带点的价格键如 `openai/gpt-4.1`、`router.stats.baselineModel`、
  fallback 数组索引）；与既有 `validateSatiConfig` 的双口径冲突。`ui/server` 是 JS，须补 `*.test.js`。
- 验证：照搬上游用例形态到 `ui/server/routes/config-model-references.test.js`（dryRun 预览 /
  `baseRevision` 冲突 409 / 删被 `agent.model` 引用者需 replacement / fallback 只删命中条目 /
  其余槽位保持），并加负控制（临时摘掉计划里的槽位 ⇒ 对应断言转红）。

### P1-7 #641 每日 token 用量统计（需适配移植）

`feat: add daily token usage statistics`（2026-10-12，+1089/−8，24 文件）

**Sati 现状**：**无任何对应模块**——`src/model/usage` 不存在、全仓 `stream_options` 零命中、
无 `ui/server/services/usageStats.js`、无 `ui/server/routes/usage.js`、无 `view/usage`。
Sati 现有的 `ui/server/routes/token-usage.js:20` 是**按会话**的内存读数（`sati` 分支返回
`getSessionTokenBudget(sessionId)`），**不持久、不按天、不跨会话聚合**——与 #641 维度不同，非重复。

**上游机制（口径要照抄，否则数据无意义）**：只记 provider 上报的用量；按**天**（`Asia/Shanghai`）
聚合，**不按模型**；路由判定 / 子代理 / 上下文压缩都计，**排除** `metadata.purpose ===
"session_title_generation"`；memory 抽取与维护明确排除；不含未上报 usage 的调用（含中断流）、
不做历史回填。写侧 `UsageCounter` 串行 append 到 `<PILOT_HOME>/usage/daily/YYYY-MM-DD.jsonl`
（一行一个整数，失败绝不影响 LLM 调用）；读侧按 `(size, mtimeMs)` 缓存，用
`createReadStream({ end: size - 1 })` 做快照读避免并发 append 重复计。

**落地建议**

- 装配点在 Sati 是 `src/cli/projectRuntimeFactory.ts:132`（上游改的 `createLocalGateway.ts` 已拆走），
  `deps.pilotHome`（`:96`）与 `deps.now`（`:98`）都已具备。
- 底座齐备，不需新建：`CanonicalUsage` 与事件联合（`src/model/protocol/canonical.ts:258-291`）、
  `normalizeAnthropicUsage`（`src/model/response/normalizeUsage.ts:3`）、
  `src/model/providers/openai/stream.ts:162-164` 已在解析 `chunk.usage`（只是不主动索取）、
  `SessionTitleGenerator.ts:99` 的 `purpose: "session_title_generation"` 标记已在。
- **重放 seam 不受影响**（与直觉相反，已复核）：`src/test-support/llm-replay/requestKey.ts:58-70`
  的请求键只投影 canonical request；`stream_options` 是 `buildOpenAIRequest` 在 provider 层加的
  body 字段，**不进键** ⇒ 无需重录。
- 风险：低-中。改动面主要在 UI/i18n（新增 `view/usage` + 设置导航键 + en/zh-CN 各约 37 行）。
- 验证：写侧串行 append 与失败隔离；读侧未变文件缓存、并发 append 不重复计、
  `Cache-Control: no-store`、失败返回 500 `usage_stats_unavailable`。

---

## 六、P2（值得做，需权衡）

| 项 | 内容与证据 | 权衡 |
|---|---|---|
| **#611 外观跨端口持久化** | 真缺陷：桌面端服务端口在 18790–18799 动态择一（`apps/desktop/src/server-manager.ts:31-32/227-234`），而主题存 `localStorage["themeMode"]`（`ui/src/contexts/ThemeContext.jsx:4/70-76`）、语言存 `localStorage["userLanguage"]`（`ui/src/i18n/config.js:137-146`）——两者按 origin 隔离，**端口一跳即丢**。上游修法是新增 `get-appearance` 同步 IPC + preload，桌面存 `userData/appearance.json` | 改动面最小（preload + 主进程 + App 启动回填），`server-manager.ts:169` 已有 userData 路径可复用。须一并决定「语言是否喂给原生菜单」。**顺带发现的既有 bug**：`ui/src/components/settings/Settings.tsx:64` 读 `window.satiDesktop`，而 `preload.ts:17-24` 暴露的是 `window.sati`，全仓仅此一处命中 ⇒ `isDesktopApp` 恒假，About 永远走 Web 分支 |
| **#611 About 增补** | 下载任务只记 `receivedBytes/totalBytes`（`desktopUpdateService.js:263-272`），About 只有「下载中…」无速度（`ui/src/components/settings/view/about/index.tsx:158-159/205-217`）；发布时间用本地化而非清单日期 | 两条独立小切片，本机可跑 UI 单测。**Web About 简化只砍 UI 入口，勿动 Sati 的 `/apply`、`/restart` 服务端链**（CLI/IM 共用） |
| **#604 浮动面板 portal 化** | `useFloatingPanel` / `placeFloatingPanel` 在 Sati 零命中，菜单仍是面板内 `absolute`（`ui/src/components/chat-v2/ComposerV2.tsx:906-908/648`）；Sati 已为遮挡写过手改注释（「气泡挂在整条工具条而非按钮上…被助手面板的 `overflow-hidden` 裁掉」），正是本 PR 要根治的 | hook 本身可直接用（含 61 行测试），但消费端 `ComposerV2`（1187 行、Sati 特有 `ContextStatusPopover` 需一并 portal 化）、`MainContent`（常量集与上游不同）、`index.css` 都不能照抄。建议单独 PR、分步迁移；`ComposerV2.tsx` 在架构基线豁免清单内，改动会撞 file-size 棘轮 |
| **#636 切片 A：`ensureProjectGitIgnore`** | Sati 把 `<projectRoot>/.sati/` 写进用户项目根（`src/session/storage/ToolResultsCleanup.ts:40`），**目前会污染用户项目的 `git status` 且无 ignore 保护**；`src/pilot/paths.ts` 与 `ui/server/utils/pilotPaths.js` 均无该函数（零命中） | 约 60 行 + 1 个 spec，上游测试可直接移植。**其余部分（完整检查点/还原/Git review，82 文件）须单独立项**：与 Sati 既有 `FileHistoryStore`（按 messageId 粒度）属同功能不同架构、替换是破坏性的；新增网关方法须走 MINOR 递增到 <!-- claim:protocol_version -->1.12<!-- /claim --> 之后的下一个版本并更新 `PROTOCOL_RELEASES` 台账（**上游未 bump，这是 Sati 独有门禁要求**）；新写回路径须显式接 `ToolGuardRegistry`，否则绕开刚立起的软链落点授权 |
| **#613 三个小补丁** | ① `FilesV2.tsx:701` 空项目 inline create 时「This project is empty.」与输入框并存（缺 `&& inlineEdit?.kind !== "create"` 守卫）；② 预览 500 时「局部错误 + 全局 Server error toast」双报（`api.js` 五个预览端点未开 `suppressServerErrorToast`）；③ 失败面板标题信息量低于上游（Sati 无 `spreadsheetPreview.cannotPreviewTitle` 键） | 风险极低（无 `inputSchema`、无协议、无 fixture 影响）。**主体机制 Sati 已覆盖**（`spreadsheetPackageNormalizer.js` 与上游逐行同构）——**勿重复移植**，重复落盘会造成第二份事实源。②的适配点：Sati 的预览走 `withUrlTicket`（`api.js:73`）票据 URL，加选项时勿动票据逻辑 |

---

## 七、明确不做

| 项 | 理由（本批新增证据） |
|---|---|
| #605 安装器半（自定义 NSIS 层 + `InstallPayload.cs`） | 该设计**同一周就被 #611 推翻**（#605 的 staging 方案正是 #611 标题里「executable remained in a sibling payload directory」事故的成因）。且 Sati `apps/desktop/resources/` 无任何 `.nsh`/`.cs`，`electron-builder.yml` 的 `nsis:` 段是原生模板、`build-win.bat` 是自研发版脚本，与上游 CI 不同构；自建 NSIS 层还会放大「安装包未签名（SmartScreen 提示未知发布者）」的风险面 |
| #629 浅色外观体系 + #631 外观部分 | 上游白标品牌的外观体系（六个浅色预设、双色渐变、背景图、独立透明度），属 feat 非 fix，与 Sati 品牌强耦合。已在 `pilotdeck-2026-10-upstream-port-plan.md` 记为用户决策不引入，维持 |
| #619 原生窗口 chrome + 应用菜单 | 收益高但改动面最大，且**强依赖两条 Sati 尚缺的通道**：preload 命令桥（`preload.ts:17-24` 只有 `isDesktop/getVersion/getServerPort/getServerStatus`）与桌面语言/外观桥；`desktop.css` 的选择器（`.app-root` / `.workspace-header` / `.project-sidebar` 在 Sati 零命中）须全部重 derive；Help 链接须换品牌（Sati 无对外文档站）。**前置就是 #611 第一条**，本轮不做 |
| #624 Ubuntu DEB / Linux 集成、#632 RPM | Sati **Linux 桌面明确不维护**（`electron-builder.yml` 无 `linux:` 段；`main.ts:440-443` 注释直写「Linux 不维护」；`main.ts:725-733` 把 Linux 归入「关窗即退出」） |
| #632 Windows ARM64 | Sati `build-win.bat` 已有 `--arm64` 分支（`:10/45/50/471/518`，按目标 arch 下载 Node/Bun 并校验 SHA256）⇒ 非缺口 |
| #634 Docker / SDK workspace | Sati 无 Docker 形态（`Dockerfile*` / `docker-compose*` 全无）、无 `packages/` 工作区、无对应 composition profile ⇒ 两个改动文件都不存在 |
| #633 SDK durable run 恢复 | 该 PR 的 base 是上游 `standalone_alpha1` 分支，且 `packages/sdk/src/client.ts` 在 tag `783499f` 的树里即为 404——**不在本 tag 范围内**。Sati 无 SDK 包、无 durable-run 分页消费方 |
| #627 首启滚动条 | 修复面全落在 Sati 不存在的自研 desktop chrome（`--desktop-caption-height` / `.desktop-prototype-shell`）与 Linux DEB feed 上；Sati 用原生标题栏，onboarding 是 Tailwind 单卡且目录下无任何 `.css` |
| #603 上传进度/取消/重试 | 缺陷面（**重名静默覆盖**）Sati 已用 `COPYFILE_EXCL` 修掉且更优（无 TOCTOU）。进度半属上游同批夹带的 feat，已在 `2026-09-30-upload-refuses-overwrite.md` 与 `pilotdeck-2026-10-upstream-port-plan.md` 两处记录拒绝；且落点被 Sati 自有同名 `ui/server/services/uploadLimits.js`（形态不同）与缺失的 `src/gateway/dialog/` 挡住。若产品确需上传进度，另立议题，勿以「移植 #603」形式提出 |
| #614 onboarding 逐模型连接探测（剩余部分） | 「测试不是门槛」的语义已覆盖（`LlmConfigurationStep.tsx:118`）。剩余部分（逐模型 `modelTests`、catalog 图片能力回落、`environmentCredentialProviderIds`、per-testId 绑定错误）绑定 Sati **不存在**的 `ui/server/routes/onboarding.js` 与 `test-connections` REST 面；`2026-09-30-onboarding-optional-connection-test.md:28` 已记录该取舍 |
| #606 macOS 菜单栏图标 | 退出保护已覆盖（`cb5feba6e` + `apps/desktop/src/quit-confirm.ts`，note `2026-09-30-desktop-quit-confirmation.md`）。菜单图标同样依赖 #611 的语言桥，边际收益小 |
| #638 / #639 / #643 整体 | 见 P1-5：Sati 零对应物，是**新子系统开发**而非移植；TCC 授权归属、嵌套 app 签名与公证**本机与 CI 都无法先行验证**（上游文档自述其授权迁移结论基于**临时签名**构建，正式 Developer ID 包的首次安装与升级验证上游自己标注未完成） |
| #649 README 发布公告 | 文档，无移植对象 |
| #553–#556、#582 dependabot | 上游 GitHub Actions 版本，Sati 自有 CI（现有为 `setup-node@v7` / `upload-artifact@v7` / `checkout@v4`），无对应改动 |

## 八、已覆盖（不必再做）

| PR | Sati 证据 |
|---|---|
| #597 配置并发写损坏 | 事务化 + CAS 已由 Sati 自研落地：`ui/server/services/satiConfigFileIo.js:63`（稳定读 250ms/3 次）、`:84`（软链写路径 + ELOOP）、`:126`（原子写 + `expectedRevision`）、`:15`（`configRevision`）；`satiConfigUpdate.js:99`（外科写 + 冲突重放 3 次）；`satiConfigWatcher.js:144`（软链与目标双 watch）；`routes/config.js:252/281`（revision 取未掩码原文）、`:508/616`（409 映射）。note：`2026-09-30-config-write-hardening.md`、`2026-10-07-config-surgical-write-and-read-consistency.md`。差异仅错误码折叠（`ConfigConflictError` vs `CONFIG_BUSY`），同为 409，无行为差 |
| #600 后台任务名额只算活跃 | `src/task/runtime/BackgroundTaskRuntime.ts:192-202` 先 `sweepFinishedTasks()` 再按 `endedAt === undefined` 统计（语义等价），另有 Sati 独有 TTL 回收。测试 `tests/task/background-task-runtime.spec.ts:291/303` |
| #602 插件 skills 只认 SKILL.md | `src/extension/plugins/loading/PluginLoader.ts:76` 即 `.filter(command => fallbackDir !== "skills" || command.isSkill)`，与上游逐字同构。note：`2026-09-30-plugin-skills-only-skill-md.md` |
| #612 cron 日字段 OR | `src/cron/runtime/CronSchedule.ts:5`（`CRON_SCHEDULE_COMPUTATION_VERSION = 3`）、`:8`（`cronDayFieldsUseOr`）、`:140`、`:89`（闰日让路）、`:245`；`CronScheduler.ts:158-185`（v2 缓存迁移取较早者）。连「按原文判据」「迁移取较早者」这些细节都一致。note：`2026-09-30-cron-day-field-or-semantics.md` |
| #613 XLSX drawings 命名空间 | `ui/server/services/spreadsheetPackageNormalizer.js:27-56` 与上游 `normalizeDrawingNamespace` **逐行同构**（连注释都一致）；`spreadsheetPreview.js:265-289` 抛 422 结构化错误；`project-preview.js:232-239` 的错误透传、`RetryPreviewButton` + 按 `code` 映射文案、docx 默认折叠均已在。note：`2026-09-30-xlsx-drawing-namespace-normalization.md` |
| #621 / #635 软链写权限 | 全部已覆盖且**是超集**：`src/tool/builtin/filesystem/pathSafety.ts:166`（逐组件解析，含 `MAX_SYMLINK_HOPS=40`）、`:70/116/120/207`（deny 列表对字面 + 真实两条路径都判）、`:123-128`（「词法在 root 内、真实落点在 root 外」闸——**比上游更严**：去掉 `allowOutsideWorkspace` 短路并带 `reason = "symlink_escape"`，`writePermissions.ts:20` 据此不再提供审批入口，上游此处返回 `ask`）；`src/permission/policy/matchPermissionRule.ts:29/40-48/131-145`（仅 allow 规则参与真实落点判定）。判据 `tests/tool/write-symlink-escape.spec.ts`（22 个 test 声明，覆盖上游 18 类场景 + 4 条 Sati 自有用例）。**⚠️ 见第十节的事实纠错** |
| #622 WebSocket 日志凭证 | `ui/server/websocket/chat.js:115`（`info.req.url?.split("?")[0]`，上方三行注释写明「Path only: the query string carries the auth token」）、`:140`（记 pathname 而非 url）。Sati 实现**更彻底**：另扩到 git stderr 与 IM 渠道 URL（`ui/server/utils/redactSecrets.js`、`src/shared/credentialRedaction.ts`）。note：`2026-10-10-token-log-redaction.md` |
| #628 标题用会话选中的模型 | `src/cli/ProjectRuntimeRegistry.ts:658` 的 `resolveRoutedModel(context.modelRoute, ...)` + `src/cli/agentSessionConfig.ts:67`（provider 与 model 双字段非空才采用路由）；`SessionTitleGenerator.ts:65` 已收窄 `agentModel` 类型。note：`2026-10-07-session-title-routed-model.md`（明确否决上游 per-turn 的 `modelOverride` 形态）。**口径差须登记**：上游按 per-turn 选模型，Sati 读会话级 `modelRoute`（装配期只建一次）——若将来新增 per-turn 覆盖入口，标题不会跟随 |
| #605 托盘半 | `apps/desktop/src/main.ts:445-464`（`createTray()`，win32-only，菜单「显示主窗口/退出」，退出不预设 `isQuitting` 而走统一确认闸门）、`:498-510`（关窗 → `preventDefault(); win.hide()`）、`:545-556`（单实例锁 + `second-instance` 恢复）、`:538-541`（shutdown 销毁托盘） |
| #606 退出保护半 | `cb5feba6e` + `apps/desktop/src/quit-confirm.ts:1-70`（`resolveQuitAction` 三态 + 中英文案），接线 `main.ts:679-694/698-714/725-733`。note：`2026-09-30-desktop-quit-confirmation.md`（其中明示 Electron 接线未在运行中桌面端验证） |
| #603 重名拒绝半 | `ui/server/services/uploads.js:210-250`（`COPYFILE_EXCL` + 207/409 + `conflicts`/`files`/`errors`）、`workspaceUploadOutcome.ts`（按载荷而非 `response.ok` 判定）。note：`2026-09-30-upload-refuses-overwrite.md` |
| #614 语义半 | `LlmConfigurationStep.tsx:117-118`（`canSave` 不含测试门槛） |

## 九、方法与证据纪律

延续前两轮的两条方法论修正，本轮又各得一例：

1. **只读路由层会漏判**（前一轮：C-2 的校验写在写盘层）。本轮实例是 P0-2——判断「文件路由是否
   校验 root」若只看 `project-files.js` 的包含性检查，会得出「已有防护」的错误结论；必须追到
   `extractProjectDirectory` 的**取值来源**才看得出 root 本身由请求决定。
2. **边界声明不可信，须逐项实测**（本轮新增）。`pilotdeck-2026-10-upstream-port-plan.md` 声明
   覆盖「#600–#632」，但其中 5 个 PR 在其自述评估时点之后才合并；据此才会发现 #620 与 #626 的遗漏。
   ⇒ 以后同步先按 `merged_at` 重算真实边界，再谈「是否已评估」。

## 十、顺带发现的事实纠错

1. **`6afe9c6d` 这个上游 commit 引用有误，已更正（两处）**：`docs/notes/implemented/2026-10-10-write-path-symlink-escape.md`
   与 `tests/tool/write-symlink-escape.spec.ts` 的文件头都写「上游 commit `6afe9c6d`」，而该 sha
   经 `gh api` 核验是 **PR #638 的 merge commit**（`Merge pull request #638 … add built-in Computer Use`），
   不含任何 pathSafety / symlink 改动。真正的上游来源是 **#621（merge `a91716a7`）+ #635（merge
   `5ac4b95a`）**（两处标题分别为 `fix(tool): check write permissions against symlink-resolved
   paths` / `fix(permission): follow up #621 symlink traversal and deny rule matching`）。两处引用
   均已改为 #621 + #635；实现与判据本身没问题，只是那一行引用错。
2. **上游 PR 编号与 Sati 议题编号会撞车**：上游 #626 = `edit_file` 字面量替换；
   Sati #626 = URL 票据载体（`docs/notes/implemented/2026-10-15-url-ticket-carriers.md`）。
   后续同步不得按编号判「已覆盖」。
3. **`docs/pilotdeck-2026-10-upstream-port-plan.md` 的边界声明偏宽**（见第一节）。

## 十一、未核验项（不静默）

| 项 | 谁因此漏了什么 |
|---|---|
| 上游 #638 / #639 / #643 的 `additions/deletions` 与合并时间 | GitHub 匿名 API 触发限速，数字取自 files 列表求和与 PR 页面时间，非 API `merged_at` 字段。对本文件结论无影响（三者的判定依据是「Sati 零对应物」这一文件级事实） |
| #649（README 公告）的措辞 | 只确认是文档改动，未逐字核对 |
| 桌面相关项（#611 的 Windows 安装与更新链、#619 的 macOS 拖拽/全屏/traffic light、#605 的安装器） | **本机无法验证**。Sati 的 CI desktop job 只跑 eslint + tsc，无原生生命周期夹具。落地这些项时须显式安排手工验收，不得以 CI 绿代替 |
| #638 若真引入的 macOS 授权归属 | 上游自述其验证基于**临时签名**构建，正式 Developer ID 包的首次安装与升级**上游也未验证** ⇒ 本机与 CI 都无法先行验证 |
| #634 的 Docker 交付必要性 | 仅核验「Sati 当前无 Docker 形态」，未评估「是否应当有」 |

## 十二、下一次同步的起点

- 本文件即 **tag `v2026.10.13-r2`（`783499f`，2026-10-13）+ #648/#649（10-15）** 边界的评估结论。
- 下次先按 `merged_at` 重算真实边界（见第九节方法论 2），再看新 tag 与 `main` 最新提交。
- 落地优先级建议：**P0-1（#620）→ P0-2（#648）→ P1-1（#626）** 三项最好同批或紧邻落地——
  前两项是安全/数据类，第三项是一行修复，都属「早一天做早一天不欠账」。
- 本文件「六、P2」与「七、明确不做」中的取舍如需翻案，须各带一条 `docs/notes/` 决策记录。

## 十三、落地情况

P0-1 / P0-2 / P1-1 已于 2026-10-15 落地，各带一条决策记录：

| 项 | 落点 | 决策记录 | 判据（含负控制） |
|---|---|---|---|
| P0-1 #620 | `ui/server/routes/projects.js`（两条 clone 路径：凭据解析前置、删掉 404 前的 `fs.rm`） | `docs/notes/implemented/2026-10-15-workspace-parent-preserve.md` | `ui/server/routes/projects.workspace-cleanup.test.js`（4 例；回退后两条「保留已存在目录」转红） |
| P0-2 #648 | 新增 `ui/server/services/projectRegistration.js` + `ui/server/middleware/projectFilesystem.js` + `ui/server/utils/pathSafety.js`；`project-files.js` / `project-preview.js` / `project-uploads.js` 共 9 个项目面挂同一守卫并改用 `req.projectRoot`；`services/uploads.js` 优先取注入的 root | `docs/notes/implemented/2026-10-15-project-file-root-authorization.md` | `projectRegistration.test.js` + `projectFilesystem.test.js` + `project-files.root-guard.test.js`（共 40 例；摘掉 `realpath` 判定则软链/大小写别名两条转红；回退整批则越权读 `server-token` 由 403 变 200） |
| P1-1 #626 | `src/tool/builtin/editFile.ts` 一行改函数替换器 | `docs/notes/implemented/2026-10-15-edit-file-literal-replacement.md` | `tests/tool/edit-file-literal-replacement.spec.ts`（18 例；回退后恰好 6 条模式用例 + 失败签名用例转红） |

**落地时相对本文件的两处偏离（明示）**：

1. **P0-2 的改动面大于第五节的建议**：第五节只写了 `project-files.js` 与 `uploads.js`，实际把
   `project-preview.js`（预览等同文件内容读取，同一条越权读原语）与 `project-uploads.js`
   一并挂上守卫——这与上游 #648 的 15 条文件面覆盖一致；只做 `project-files.js` 会留下同一个洞。
2. **`upload-images` 按设计豁免**：它只用 `req.user.id` 与临时目录，从不解析项目 root（解析
   projectName 的 `path`/`os` 在该处理器内被局部遮蔽），故无待授权的 root；该豁免在接线契约
   测试中显式登记并有反向断言防止「豁免烂掉」。

**未做（本批明确不动）**：P1-2 起的各项，以及第十节第 1 条的引用更正**已顺手做完**（两处：
note 与 `tests/tool/write-symlink-escape.spec.ts` 文件头）。`git.js` / `taskmaster.js` 的文件内容
可达面仍未收口，见决策记录「未覆盖（明示）」——建议独立议题，勿以「移植 #648」形式提出。

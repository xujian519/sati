# Sati × PilotDeck 引入方案（v2026.09.19 之后的增量，2026-10 批次）

Status: implemented（批次 A–E 全部落地；批次 C 的一项经复核**已在更早的提交中存在**，见「三、判定更正」）

范围基线：上游 `OpenBMB/PilotDeck` 在 **PR #599（`cd52c9af`，2026-09-18）之后**的增量
——评估时点上游 `main` @ 2026-10-06，含 PR #600–#632 与 tag v2026.09.23/24/25/29/29-r2/30/10.01
基准提交：Sati `main`；上游 force-push 无法 `git merge`，只能手工语义移植 ⇒ **成本在「判定」不在「搬」**
交付形态：一个 PR（[#610](https://github.com/xujian519/sati/pull/610)，合并提交 `b5686a26a`）；main 受保护
决策记录：`docs/notes/implemented/2026-10-07-config-surgical-write-and-read-consistency.md`、
`2026-10-07-session-title-routed-model.md`、`2026-10-07-web-search-provider-expansion.md`、
`2026-10-07-upload-limits-and-probe-throttle.md`（均为 2026-10-10 收尾时补记——PR #610 未随变更附 note）

---

## 一、判定结果总览

> 本节判定取自 2026-10-06 的增量评估（逐文件聚合 #600–#632 的 141 条提交）。本轮收尾只复核了**落地批次 A–E 与 C-2 的处置**（见第二、三节），未重新评估下方「不引入」各项。

141 条提交（#600–#632）逐文件聚合后，落到 `^src/` 的唯一文件**仅 22 个**；`ui/` 与 `apps/desktop/` 占绝大多数。

### 全局负面结论（下次同步直接跳过）

| 域 | 结论 |
|---|---|
| `src/model`、`src/router`、`src/context`、`src/memory` | 四目录零改动 |
| `src/gateway/protocol/version.ts` | 未触及 ⇒ 本次无需升协议版本 |
| 协议层整体 | 上游只有单一常量版本号，Sati 是自建 `PROTOCOL_RELEASES` 台账 ⇒ 上游协议改动无移植对象 |

### 已有对应模块、但 Sati 已覆盖且更强 / 已分叉（不引入）

| 项 | Sati 证据 |
|---|---|
| #612 cron day-fields OR | `src/cron/config/CronSchedule.ts` 已在；`CronScheduler` 的 v2 缓存双条件保留 + 闰日 OR 例外，强于上游 |
| #600 后台任务限流 | `BackgroundTaskRuntime` 语义等价，另有上游没有的 `sweepFinishedTasks()` TTL 回收 |
| #602 插件 skill markdown | `PluginLoader` + `PluginCommandLoader` 已在 |
| #613 XLSX drawings 命名空间 | `spreadsheetPackageNormalizer.js` 与上游 `normalizeDrawingNamespace` 逐行同构 |
| #613 CodeEditorBinaryFile | Sati 同名文件约 148 行（上游 1000+），零命中 error/retry ⇒ 预览架构已分叉，无落点 |
| #603 `src/gateway/dialog/UploadStore.ts` | Sati 无 `src/gateway/dialog/`；上传重名拒绝 + 207/409 已在 `ui/server/services/uploads.js`，且用 `COPYFILE_EXCL`（无 TOCTOU），优于上游 `lstat` 预检 |
| #597 `memory.enabled` 显式化 | `src/pilot/config/optionalFeature.ts` 载明 memory 被刻意排除在三态门外；照搬即降级 |
| #614 onboarding 逐模型探测 | Sati 无该路由与该架构（仅摘出限流一项，见批次 E） |
| #624 Ubuntu DEB / #632 RPM | `apps/desktop/electron-builder.yml` 无 linux 节（与「Linux 不维护」一致） |
| #632 Windows ARM64 | `build-win.bat` 已有 `--arm64` 分支 ⇒ 非缺口 |
| `projectMcpSpec.ts` / `funasr` / `install-asr.mjs` / `browser-use/scripts/` | Sati 均无对应模块 |
| dependabot ×5（#553–#556、#582） | 上游 GitHub Actions 版本，Sati 自有 CI |

### 用户已决策不引入

- **外观主题体系**（#629 + #631 外观部分，约 20 个提交）：白标分支品牌强耦合，且属 feat 非 fix。
- **桌面端**（#619 原生窗口 chrome、#605/#606 托盘与退出保护、#611 更新）：Sati 桌面端已分叉（自有 `release.sh` / `build-win.bat` / `electron-builder.yml`）。

---

## 二、落地批次

| 批次 | 内容 | 落地提交 | 状态 |
|---|---|---|---|
| A (P0) | 配置写盘外科化：`updateSatiConfig(mutate, { paths })` + gateway 路由 7 处 `saveYaml` 迁移 + 首启写盘原子化 + CAS（写前 `previousRevision`） | `5aaa545f6` | ✅ |
| B (P1) | 配置读一致性：revision 取自**未掩码**的原始 YAML；软链配置的 watcher 跟随写目标（读写对称） | `5aaa545f6` | ✅ |
| C-1 (P1) | 会话标题采用会话路由模型（`resolveRoutedModel`） | `e645f2697` | ✅ |
| C-2 (P1) | 模型删除的悬空引用校验 | **已存在于更早提交**，测试于 `5aaa545f6` 补齐 | ✅（判定更正） |
| D (P1) | `web_search` provider 补齐 6 家（serper / brave / baidu / bocha / exa / serpapi）并对齐设置页 | `7c4feed6e` | ✅ |
| E (P2) | `/test-connection` 探测限流（10 次/分钟）与上传限额单一事实源 + `GET /api/upload/limits` | 限流 `5aaa545f6`，限额 `899eeece4` | ✅ |
| — | 技术债台账 / 架构基线 / 文档事实层回填 | `cdf4c9328` | ✅ |

逐项决策背景、放弃物与后果见上列四条 note。

### 与计划的形态偏差（行为等价）

| 计划写的形态 | 实际落地 | 原因 |
|---|---|---|
| 新增 `src/tool/builtin/additionalWebSearch.ts`（79 行） | `src/tool/builtin/webSearchPerformers.ts`（584 行）+ `src/pilot/config/webSearchAdapter.ts`（190 行）+ `webSearchProviders.ts`（53 行），`webSearch.ts` 722 → 322 行 | 计划只算「新增 6 家」，实现时把 tavily/glm/custom 三个既有 performer 一并下沉，并把「请求构造 + 响应归一化」拆到 `src/pilot` 供工具与 `ui/server` 路由共用（避免两处各写一份归一化）；`webSearchProviders.ts` 成为 provider/端点/文档入口的单一事实源 |
| 批次 E 的限流与限额同批 | 限流随配置写盘提交（`5aaa545f6`）落地，限额单独提交（`899eeece4`） | 两者无耦合，按提交可独立回滚拆分 |
| C-2「PUT 前置引用扫描 + 409 `MODEL_IN_USE`」 | 复用既有 `validateSatiConfig` 的悬空引用校验，返回 400 + `validation.errors` | 见下节 |

---

## 三、判定更正：批次 C-2 的缺陷面在 Sati 不存在

计划原文依据 `ui/server/routes/config.js` 的 `PUT /` 只处理 `providerRenames` 与掩码密钥，判定「无悬空引用校验」，并拟新增 409 `MODEL_IN_USE`。**该判定只看了路由层，漏了写盘层的校验**：

- `writeSatiConfig` / `writeRawSatiYaml` → `validateSatiConfig`（`ui/server/services/satiConfig.js`）在落盘前校验引用：`agent.model` 与 `memory.model` 为 **error**，`router.scenarios.*` / `router.fallback.*` / `router.tokenSaver.judge` / `router.tokenSaver.tiers.*.model` 为 **error**（`router.enabled === false` 时跳过）。两条写入路径（raw YAML 与结构化 `config`）都走同一份校验。
- `agent.subagents.default` 不是硬拦而是**自愈**：写盘前的 `purgeBootstrapPlaceholder` 把「指向已消失 provider」的子代理默认模型归一到 `inherit`（子代理回退主模型，磁盘上不留悬空引用）；`validateSatiConfig` 里同名的 **warning** 分支只在读侧（GET 对磁盘原文）可达。
- 校验早于本批次存在（`cad4f61d0` 全量同步时移植，`ed062e46d` 修正）；本批次为它补了用例，收尾时又修正 fixture 并补三条（见第五节）。用例现居 `ui/server/routes/config-model-references.test.js`——从 `config.test.js` 抽出：后者命中 `check-architecture-boundaries` 的 file-size 豁免，棘轮不允许存量豁免文件继续增长。
- 前端可见：`ui/src/hooks/useSatiConfig.ts` 的保存失败分支把 `data.validation.errors.join(", ")` 作为错误文案抛出；raw 编辑面板另在 `ui/src/components/settings/view/advanced/index.tsx` 直列 `validation.errors`。
- 因此**不再新增** 409 `MODEL_IN_USE`：那会是同一约束的第二套口径，且比现有校验更窄（只覆盖两个引用位、只覆盖 `PUT`）。

---

## 四、已知缺口（不静默）

| 缺口 | 谁因此漏了什么 | 处置 |
|---|---|---|
| `GET /api/upload/limits` 无客户端消费 | 桌面端 / Web 端仍未按各自限额给出「选文件前提示」——本批只做到了「限额可查、可单点调参」 | 待前端接线时一并做；接口已稳定 |
| 上传限额无测试 | 无自动判据防住 `uploads.js` 重新硬编码 50MB/20；探测限流有测试（`config.test.js`），限额没有 | 待补 |
| 服务端权威引用**改写**未做（上游 #631 批次 B） | 删除 provider 仍需客户端先改写引用（`ui/src/.../modelPool/utils/providerRefs.ts` 自有分叉），服务端只拦不修 | 单独立项评审：照搬上游会与既有客户端分叉形成双写 |
| `providerRefs.ts` 客户端分叉保留 | 与上游同名文件语义不同，后续同步不可直接比对 | 已在 note 记录分叉事实 |

---

## 五、验证记录

- 门禁：`pnpm check`（含领域门禁）、`pnpm --filter sati-ui test`（含 `ui/server` 套件）。
- 悬空引用：`ui/server/routes/config-model-references.test.js` 五条实测通过（`config.test.js` 35 条同跑通过）。收尾时发现原两条用例的 fixture 把 `model.providers[*].models` 写成**数组**，而 `resolveModel` 只认映射（`isRecord` 排除数组）——引用从未解析成功，用例是「因错误的原因通过」（假绿）。已改为映射形态，并补三条：同配置不改动保存成功（对照，防校验误报）、删除被 `agent.model` 引用的整个 provider 被拦、悬空的 `agent.subagents.default` 落盘前归一为 `inherit`。负控制：临时摘掉 `agent.model` 校验 → 前两条转红；临时摘掉 subagent 归一 → 第三条转红（均已还原）。
- 搜索 provider：`tests/pilot/config/webSearchAdapter.spec.ts`（六家请求构造与各自限额夹取、六种响应形态归一化、serpapi 空结果、密钥三形态脱敏）、`tests/pilot/config/parseToolsConfig.spec.ts`（provider 枚举 / `searchEngine` 解析与白名单）、`tests/tool/builtin/webSearch.spec.ts`（逐 provider 端点路由、env 推断、错误信息脱敏、超时归一）。
- 标题模型：`tests/cli/agent-session-config.spec.ts`、`tests/session/title/SessionTitleGenerator.spec.ts`。
- 重放 fixture：本批未改任何工具 `inputSchema`（`web_search` 的 `searchEngine` 是 provider 配置项，**未**进 `inputSchema`），不触发重录。
- 生成物回填：`pnpm gen:doc-claims`、`pnpm measure:update`（见 `cdf4c9328`）。

---

## 六、下一次同步的起点

- 已消耗到 **上游 main @ 2026-10-06（PR #600–#632）**；本文件即该边界的评估结论。
- 下次先看 2026-10-06 之后的 tag 与 `main` 最新提交，再按「一、判定结果总览」的同一方法逐项过：**先核对目标模块在 Sati 是否存在**，再谈移植；已有等价模块的，先比「谁更强」。
- 下次可优先复核本文件「四、已知缺口」中仍挂着的两项（上传限额的客户端接线与测试、上游 #631 批次 B 的引用改写归属）。

---

## 附：判定过程中的两个方法论修正（延续上一轮）

1. **只读路由层会漏判校验是否存在**——C-2 即此类：约束写在写盘层（`validateSatiConfig`），路由只是调用方。判定「有无某校验」必须追到落盘前的那一层，而不是路由体。
2. **「上游补丁不能照搬」≠「Sati 无此缺陷」**——与上一轮 #628 同一形态；本批次 D 也是同类（上游只改 provider 枚举与描述，落地方需连带对齐设置页与 YAML 校验）。

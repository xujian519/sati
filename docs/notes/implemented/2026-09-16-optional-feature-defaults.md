# Agent Note: 可选功能「未配置 = 关闭」（上游 #588 裁剪版）

Status: implemented

## Problem

未配置的可选功能此前都是**开着**的，而且是隐式的：

| 位置 | 旧行为 |
|---|---|
| `src/cli/routerDefaults.ts` | `router` 段缺失时返回全 `enabled: true` 的默认配置（scenarios / fallback / zeroUsageRetry / tokenSaver / autoOrchestrate / stats 全开） |
| `src/cli/projectRuntimeFactory.ts` | `tools.webSearch` 缺失 → 传 `{}`，`web_search` 照常注册，并可从 `GLM_WEB_SEARCH_API_KEY` / `TAVILY_API_KEY` 自我唤醒 |
| `src/pilot/config/parseToolsConfig.ts` | 全字段被丢弃的空块（`webSearch: {}`）返回 `undefined`，丢掉"遗留 opt-in"语义 |

后果不是报错，而是**用户不知情的开销与能力**：没配过路由的用户每次请求多一次分类调用；没配过搜索的用户拿到一个自己没申请过的工具。

而这个修复自身带一个反向风险：`ui/server/services/satiConfig.js` 的 `normalizeSatiConfig`
是**保存路径的最后一站**（PUT → `writeSatiConfig` → `normalizeSatiConfig` → 落盘），
一旦默认值变成 `enabled: false`，用户任何一次"读取 → 保存"都会把遗留配置里
"段在、没写 enabled"的既有功能**静默改写成关闭**——包括 `patent_workflow_run`
多源检索赖以取文献的 `tools.paperSearch`。

## Decision

三态判据（`src/pilot/config/optionalFeature.ts`）：段缺失 → 关；段存在但无 `enabled` → 开；
显式 `true`/`false` 永远优先。UI 侧有同语义副本 `ui/src/components/settings/shared/utils/optionalFeature.ts`
——面板与运行期必须同判据，否则会出现"面板显示开、实际关"。

- `ensureRouterConfig`：缺段短路为 `{ enabled: false }`，其余分支合并为一支（只对显式配置过的 router 补默认子段）。
- `projectRuntimeFactory`：`webSearch` / `paperSearch` 均改为 `!isOptionalFeatureEnabled(config)` → 传 `false as const`（不注册）。
- `parseToolsConfig`：两个搜索块的返回改为 `return result`，空块在场即保留。
- `buildDefaultSatiConfig`：新增 `router: { enabled: false }`、`tools.webSearch/paperSearch: { enabled: false }`；**`memory.enabled` 保持 `true`**。
- `normalizeSatiConfig` 增遗留守卫：`source` 里段在而无 `enabled` 时，把归一结果的该字段物化为 `true`。
- Search 面板新增「启用文献检索」开关（超出方案原文的补充，见下）。

## Alternatives considered

- **全量对齐上游（含 `memory.enabled` 默认值翻转）** — 落选（用户已确认）：会让既有无 memory 配置段的用户停掉记忆索引调度器（`memoryService.js` 以 `config.memory?.enabled` 为闸），影响面超出本批收益。
- **只做 router** — 落选：保留了"搜索被环境变量隐式开启"这一用户不知情的状态。
- **仅加诊断告警、暂不翻转语义** — 落选：告警无人看，等效于不修；翻转 + 迁移守卫已能覆盖风险。
- **`paperSearch` 不给面板开关（照方案原文，只走「高级 → 原始 YAML」）** — 落选：翻转影响的是"从未手写过 `paperSearch` 段的所有既有用户"，而 `paperSearch` 不只是两个工具——它同时是 `patent_workflow_run` 多源检索的文献源（`createBuiltinRegistry` 用同一 registry）。没有面板开关，这批用户会失去一个自己无法从界面恢复的能力；方案自己的风险条目也写着"需在设置面板显式开启"，这条要求只有在开关存在时才成立。
- **UI 深引 `src/pilot/config/optionalFeature.ts`（上游原样写法）** — 落选：违反 `ui/` 不得导入 `src/` 的边界铁律（`AGENTS.md` 强制规则 2）。改为 UI 侧同语义副本；两份实现可能漂移的风险由测试承担（面板四态用例 + 服务端守卫用例）。
- **让 `parseToolsConfig` 继续在空块时返回 `undefined`，由装配点按 `undefined` 判** — 落选：那样"未配置"与"配了空块"在数据上不可区分，遗留 opt-in 无法表达，只能靠读文件猜。

## Consequences

- **行为变更（必须进发布说明）**：无 `router` 段的用户会失去场景分类 / TokenSaver / 自动编排 / 统计——**模型调用本身不受影响**（禁用路径即直通，`executeRouterDecision` 的 `!enabled` 分支）；无 `tools` 段的用户失去 `web_search`、`paper_search`，且 `patent_workflow_run` 的检索回退为 nuo 单源。两类恢复路径：面板开关（搜索）或写回该段（router 走「高级 → 原始 YAML」）。
- **迁移守卫是安全关键，不是锦上添花**：临时移除守卫后，`ui/server/services/satiConfig.test.js` 的两条用例立刻转红，落盘内容是 `webSearch: { enabled: false, provider: tavily }`——正是要防的静默关闭。
- 代价：`ui/src/components/settings/view/modelPool/types/index.ts` 的 `SatiConfig` 与面板渲染范围不再一致（`paperSearch` 的连接器子字段面板不渲染，但写侧必须原样保留——见 `2026-09-16-tools-section-segment-replacement.md`）。
- 上游 #588 的分支里还带了 Always-On 项目默认关、飞书/微信/企微适配器默认关、onboarding 保留高级配置三项；本仓未跟进（渠道与常驻执行的现状与上游已分叉），因此本 note 只覆盖 router 与两个搜索工具。

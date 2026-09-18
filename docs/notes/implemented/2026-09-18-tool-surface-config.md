# Agent Note: 工具面可按项目配置裁剪（域裁剪 + 内置工具组开关）

Status: implemented

## Problem

新会话的第一个请求固定携带约 3.2 万 tokens 的 system prompt + 工具 schema，对 128k 窗口即约 25%（实测见 #450）。用户手上没有任何开关能削减它：

- `createBuiltinRegistry` 早就支持 `patent` / `documentStyle` / `kanban` / `team` 等注册开关，但装配点（`src/cli/projectRuntimeFactory.ts`）把这些参数写死——`documentStyle: {}`、`kanban`/`team` 无条件透传，配置层没有字段能表达"这个项目不需要它们"。
- 域裁剪能力（`ToolRegistry.listByDomains`、`visibleDomains` / `hiddenDomains`）只接给了子代理与团队成员会话（`src/agent/sub/scopeTools.ts`、`src/cli/sessionToolSurface.ts`），主会话与项目注册表永远全量。

结果是专利域 28 个工具（约 13.5k tokens）、三组内置工具（约 4.2k tokens）在每一个会话、每一轮请求里重复计费。

## Decision

`tools` 段新增四类字段，全部在项目注册表构建点落地（`src/cli/projectRuntimeFactory.ts`）：

| 字段 | 语义 | 判据 |
|---|---|---|
| `visibleDomains: string[]` | 只保留这些 domain 的工具 | 未设 = 不限 |
| `hiddenDomains: string[]` | 隐藏这些 domain 的工具（优先于 visible） | 未设 = 不限 |
| `documentStyle` / `kanban` / `team` | 三组内置工具是否注册 | 段缺失 = **开**，显式 `enabled: false` 才关 |

- 域裁剪复用 `ToolRegistry.listByDomains` 的既有语义（hidden 优先；未标注 domain 的工具不受约束），不新写一份域匹配逻辑。
- 裁剪发生在**项目注册表**层：主会话、子代理与团队成员会话都从这份注册表派生，因此项目配置对三者一致生效。
- 新判据 `isBuiltinToolGroupEnabled`（`src/pilot/config/optionalFeature.ts`）与 `isOptionalFeatureEnabled` 的三态**相反**：段缺失 → 开。
- 可观测性：裁剪结果记 `logger.info`；配置里没有任何工具命中的域记 `logger.warn`（拼写错误可见）。
- 显式标注语义的例外：未标注 domain 的通用工具（`kanban_*`、`structured_output` 等）不受域白名单约束，关闭它们要用对应工具组开关——这是 `listByDomains` 的既有契约，不改。

实测（真实网关装配 + 假模型，`tests/gateway/tool-surface-config.spec.ts` 锁定的行为）：

| 配置 | 工具数 | system + tools | 128k 窗口占比 |
|---|---|---|---|
| 默认（改动前基线） | 79 | 35,463 | 27.1% |
| 默认（技能清单去路径后） | 79 | 34,052 | 26.0% |
| `hiddenDomains: [patent]` | 51 | 21,906 | 16.7% |
| 三组工具全关 | 51 | 31,262 | 23.9% |
| `visibleDomains: [filesystem, shell]` | 23 | 15,427 | 11.8% |

（`<available-roles>` 1.9k 未动；`<available-skills>` 里的技能**描述**保留——见下。）

## 技能清单：`read_skill` 在场时省略逐条路径

`src/context/prompt/PromptAssembler.ts` 的 `formatSkills` 改为按工具面二态渲染：

- **有 `read_skill`**（网关/桌面正常装配）：只声明去重后的技能根目录，条目为 `- <name> — <description>`，不再逐条输出绝对路径。
- **无 `read_skill`**（fixture 录制路径 `scripts/record-real-fixture.ts` 的注册表即此形态）：保持逐条 `(file: …)`——没有该工具时，路径是模型读取技能的唯一线索。

省 1.4k tokens（`<available-skills>` 5,059 → 3,645），且不损失能力：`read_skill` 按名字取全文，不依赖路径。技能描述保留。

## Alternatives considered

- **同时翻转默认值（默认隐藏 patent 域、默认关三组工具）** — 落选：这三组与专利域是本产品的核心能力面，翻默认会让既有用户升级后静默失去功能；默认路径一变，llm-replay fixture 的 `toolSchemaDigest` 立即失配（须重录）。开关先落地，默认翻转需先有迁移守卫（可参考上游 #588 在 `ui/server/services/satiConfig.js` 的做法，见 `2026-09-16-optional-feature-defaults.md`）。
- **新写一个域裁剪纯函数** — 落选：`ToolRegistry.listByDomains` 已实现同语义且有测试（`tests/tool/registry/domain-filter.spec.ts`），复制会产生两处必须同步的域语义。
- **在会话层（`src/cli/sessionToolSurface.ts`）裁剪，只影响主会话** — 落选：子代理与成员会话都从项目注册表派生工具，项目级约束才能保证三者一致；放在会话层会让"项目声明不用某域"在子代理侧失效。
- **复用 `isOptionalFeatureEnabled`（段缺失 = 关）** — 落选：语义相反，无 `tools.documentStyle` 段的既有配置升级后会失去面板/看板/团队工具（同 #588 的翻车风险）。
- **让域白名单也约束未标注 domain 的工具** — 落选：破坏 `listByDomains` 的向后兼容契约，且通用工具（看板等）无法用 domain 表达开关。
- **在设置页加表单** — 本轮未做（未列入 #450 的 1、2 条）：新字段目前只走 `sati.yaml` / 设置页「原始 YAML」；加表单要连带 i18n 与视觉验证，留作后续。
- **技能清单连描述一起去掉（"仅列名称"，估算再省 3.2k）** — 未采纳：技能描述是模型判断"这个技能有没有用"的主要线索，去掉后每次都要先 `read_skill`（返回全文，通常比描述贵一个量级），对本仓 63 条技能是否净收益不确定。若要做，应配显式开关而非改默认。
- **把技能清单整体移出 system prompt，改由 `list_skills` 工具按需拉取** — 未采纳：多一次往返，且模型不调用就完全看不到技能；省下约 4.6k 不足以抵消"技能发现率可能归零"的风险。

## Consequences

- 用户可用几行 YAML 把初始固定开销换成对话预算：`hiddenDomains: [patent]` 省 13.6k tokens（27.1% → 16.7%），三组工具全关省 4.2k，按域白名单收窄到文件系统与 shell 省 20.0k（11.8%）。
- 默认行为逐字不变：集成测试锁定"无 `tools` 段与 `tools: {}` 的结果一致"，因此 fixture 与既有部署不受影响。
- 代价一：域裁剪是项目级的，子代理无法越过项目配置使用被隐藏的域——项目隐藏 patent 后，专利角色子代理同样拿不到专利工具。这是配置表达的意图，若只是想让主会话瘦身，应改用具组开关或按工作区拆分项目。
- 代价二：`team` / `kanban` 工具关闭后，网关侧的团队子系统与看板管理器仍然存在（UI 面板可用），但 agent 失去操作它们的工具，需要用户自行判断是否接受这种"人能操作、模型不能"的状态。
- 配置字段目前只被 `parseToolsConfig` 校验语法（域名的拼写靠"未命中告警"兜住），不做 domain 枚举校验：`ToolDomain` 是封闭联合类型，但新增域时不必同步改配置校验。
- 技能清单去路径**不影响 llm-replay fixture**：录制与重放路径都不注入 context runtime（`NullContextRuntime` 不产出 systemPrompt），请求键不含清单文本；`tests/test-support/llm-replay-real.spec.ts` 已复跑通过。若某部署的注册表缺 `read_skill`，清单自动回到逐条路径形态——随工具面自适应，无需配置。

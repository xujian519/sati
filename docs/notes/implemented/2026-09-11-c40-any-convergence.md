# Agent Note: C40 日卡——工具渲染注册表的 any 收敛

Status: implemented

## Problem

C40 卡的目标是 `any` / `@ts-expect-error` 逃逸收敛（主链路优先 + 外围 SAFETY 注释）。盘点后的实际分布与卡面预期不同：

- **主链路（`src/`）已是零真实逃逸**。C40 报告期（2026-08-20）点名的两个热点 `planMode.ts`(6)、`MessageProjector.ts`(5) 已在此前的 C05/C06 死代码清理中消失；`src/` 剩余的匹配项全部是注释/字符串里的英文单词 `any`（如 `lookup.ts` 的 "any catalog provider's"），非类型位。
- **逃逸集中在 `ui/src`**，且 14 处（占 3/4）压在单个文件 `tools/configs/toolConfigs.ts`。该文件顶部有一条**既有的、显式记录的推迟决策**（文件级 `eslint-disable @typescript-eslint/no-explicit-any`，理由是"跨 17+ 工具结构各不相同，静态建模收益低，待工具协议收敛后分批处理"）。因此"收敛它"不是纯机械清理，而要推翻一条已入库的决策。
- 该文件同时是 C28/C29 等 UI 卡明确"归横切处理"的落点（例如 C29 记录"横切仅 1 处 `data?: any`（已有 eslint-disable 注释，记录不处理）"），C40 正是这些挂账的清算卡。

关键事实（决定了本卡的技术路线）：`ToolRenderer.tsx:148` 消费配置时**已经把配置转成 `unknown` 视图**——`const displayConfig: ToolDisplaySection | undefined = ...`，而 `ToolDisplaySection` 的 handler 签名本来就是 `(input: unknown) => string`。也就是说：`ToolDisplayConfig` 里的 `any` 只是**编排侧（authoring side）的逃逸**，消费侧契约早已是 `unknown`。两侧不一致，收敛只是让编排侧对齐既有契约，**不改动任何消费路径**。

## Decision

1. **`ToolDisplayConfig` 的 handler 参数对齐 `ToolDisplaySection` 契约**：`getValue`/`getSecondary`/`getMessage` 收窄为 `(input: unknown) => ...`，`title` 为 `string | ((input: unknown, helpers?: unknown) => string)`，`getContentProps` 返回 `unknown`（原为 `any`）。因两侧签名一致，`ToolRenderer` 的赋值无需改动。
2. **引入一个载荷词汇表替代裸 `any`**：`export type ToolPayload = Record<string, unknown>` + 4 个模块私有读取器 `payloadOf` / `field` / `text` / `optionalText`。约定是「对象视图 + 逐字段收窄」：`field()` 对非对象载荷返回 `undefined`（等价于原先的 `?.`），`text()` 对非字符串回退空串，`optionalText()` 对非字符串回退 `undefined`。
3. **逐处就地收窄共 16 处**：`toolConfigs.ts` 14 处 → 0（含删掉文件级 `eslint-disable`），`modelPool/utils/patch.ts` 2 处 → 0（改为 `readAt` / `writeAt` 两个 helper + `useArrayKey` 分支，保留"数组下标走浅拷贝数组、其余走浅拷贝对象"的原有分派）。
4. **保留 3 处逃逸并逐条登记**（判据：收敛它们需要先做一次行为面决策，属另卡）：
   - `chat/hooks/useChatComposerState.ts` `data?: any` —— 内置命令按 `action` 分派的异构负载（help/model/cost/status/memory/rewind/skillInstall/switchProject 各不同），约 30 处真值判断+模板拼接；收敛为逐 action 判别联合需同时决定各字段缺失时的兜底值（例如 `data.content` 缺失时渲染 `undefined` 还是 `""`），是行为面变更。
   - `chat/tools/ToolRenderer.tsx` `toObject(value): Record<string, any>` —— `getContentProps` 的产物按 `contentType` 分派给 diff/file-list/todo/task 等子组件，收敛需先定义各 contentType 的 prop 契约。
   - `main-content-v2/SkillsV2.tsx` `@ts-expect-error webkitdirectory` —— 非标准 DOM 属性，React 类型未声明，属**正当豁免**（替代写法只有更差的断言），补 SAFETY 说明。
5. **`patch.ts` 补 5 例单测**（`patch.spec.ts`）：原文件零测试，而本卡改写了它的容器构建路径，用测试钉住"不可变、缺省容器、数组按索引重建、空 path 直返"四条语义。

## Alternatives considered

- **全量逐工具静态建模**（为 17+ 个工具各写 input/result 接口，`ToolDisplayConfig` 泛型化）——收益最高但代价最大：会波及全部 config 实现处，且与 C40"只做无行为变化清理"的保守档边界冲突；更关键的是它改的是**编排侧形状建模**，而消费侧契约（`unknown`）不需要它。留作"工具协议收敛"专项，与本卡正交。
- **走纯 SAFETY 注释路线（不收敛 `toolConfigs.ts`）**——这是最保守、且字面符合卡面"外围加 SAFETY 注释"的读法，可保住既有推迟决策、diff 最小。否决理由：卡面同时写了量化目标 ≤10（当前 21），只加注释则指标不动，卡片交付形同空转；且 UI 卡已把这类逃逸"归横切"，C40 再推一轮等于挂账搬家。
- **`Record<string, string | undefined>` 之类"善意谎言"型**——能让多数 handler 一行不改地通过编译，但布尔字段（`recurring`/`durable`）与数组字段（`todos`）会被谎报为字符串，属把类型债藏得更深；且 `input.recurring === false` 这类比较会直接编译失败。
- **在 `text()` 里用 `String(v)` 兜底而非回退空串**——`String(undefined)` 得到 `"undefined"`，会把原先渲染为空白的位置变成字面量 `"undefined"`，是可见的渲染回归。选回退空串。
- **顺手把 `ToolRenderer.toObject` 一并收敛**——只有 2 个调用点，看似顺手；但其下游是 ~20 处按 `contentType` 分派的 prop 传值，收敛等于顺带定义 4–5 套子组件 prop 契约。放在同一提交里会让 diff 失去可审性，登记为后续卡。

## Consequences

- **量化**：四个改动文件按同一正则统计，类型逃逸 `18 → 2`（`toolConfigs.ts` 14→0、`patch.ts` 2→0、`SkillsV2.tsx` 1→1 正当豁免、`useChatComposerState.ts` 1→1 已登记）；仓内 `any` 类型位 + `@ts-expect-error` 加总 `21 → 5`（含 `ToolRenderer` 那处不在本卡范围的记录项），达标卡面 ≤10。裸 `console` 与 C41 类指标不受本卡影响。
- **行为面唯一的语义决定**：handler 收到**非字符串 / 缺失**字段时，原先 `any` 会原样透传（数字被 React 渲染成数字、对象渲染成 `[object Object]`、缺失时 `.split` 直接抛错），现在统一回退空串/`undefined`。该决定已用**渲染缝等价性对照**量化（临时对照脚本：取 `origin/main` 版与收敛后版，对 22 个工具 × 入参/结果 × 5 组 helpers 逐 handler 调用并比较）：
  - **良构载荷（字段类型符合 inputSchema）1621 条断言全绿**：渲染缝零差异。比较在渲染缝上进行——`getValue`/`getMessage`/`title` 按 `toDisplayString` 归约（`undefined` 与 `""` 同渲染），`getSecondary` 保留 `undefined` 语义（调用方以 `=== undefined` 决定是否渲染次要行，故该处专门用 `optionalText` 而非 `text`），`getContentProps` 深归一化。
  - **类型违约载荷（模型违反 schema 传数字/对象等）72 条差异，归为 4 类**：① **原代码抛错 → 新代码优雅回退**（`Edit.title` 遇 `file_path:123`、`Bash.result.title/getContentProps` 遇非字符串 content、`exit_plan_mode`/`ExitPlanMode` 遇 `null` result —— 即收敛顺带消除了 5 条崩溃路径）；② 原渲染 `[object Object]`/数组/数字回显 → 新回退空值；③ 数字 `taskId`/`cron`/`questions[].header` 的标签由 `#9`/`5 · recurring · session`/`9` 变为默认值（**唯一"信息量下降"方向**，仅当模型违反 schema 时可见）；④ `TodoRead` 遇 `null` result 时 `todos` 由 `[]` 变 `null`（下游 `contentProps.todos?.length > 0` 与 `TodoListContent` 的 `Array.isArray` 双重守卫，渲染等价）。
  - **组件级 DOM 对照（第二层证据，直接对应 PR 的"视觉验证"）**：本轮再加一层更贴近视觉的验证——用 `// @vitest-environment jsdom` + `@testing-library/react` 渲染**真实的 `ToolRenderer`**（`ToolRendererErrorBoundary` → `CollapsibleDisplay`/`OneLineDisplay` → diff/todo/text 等子组件全链路），仅在 `vi.mock` 处把配置注册表换成 `origin/main` 版，其余模块完全一致；对 84 个载荷用例比对 `container.innerHTML` 与 `console.warn` 条数：
    - **良构组 DOM 逐字节相同，零差异**（无任何用例落入 `<details open>` 之外的可见差异）。
    - 差异共 14 例，**全部落在违约组**，形态与第一层一致：`Edit`/`Write`/`ApplyPatch` 标题 `Details → file`、`Bash` 结果 `42 → Output (empty)`、`Grep` `{"p":1} in 9 → (空)`、`TaskUpdate` `#7 → completed` 退化为 `completed`、`TaskGet` `#9 → fetching`、`CronCreate` `5 · recurring · session → recurring · session`、`AskUserQuestion` 标题 `9 → Question`。
    - **8 例在旧代码下触发 `safeCall` 的 `logWarn`，新代码 0 条**——旧代码在这 8 条违约载荷上抛错（被 `safeCall` 兜住并记警告），新代码既不抛错也不记警告。即**本卡减少控制台诊断，而非新增**，与 PR 模板"控制台无新增 error/warning"同向。
    - 反向校验（防"自我对照"假阴性）：mock 生效由两点佐证——差异只出现在预测的违约组，且 8 例 `logWarn` 恰好消失；新侧 0 条 `logWarn`，排除 mock 泄漏到新侧。
  - 结论：**良构输入下 DOM 逐字节等价（84 例中 70 例完全相同，14 例差异全部来自违约载荷）；病态输入下的差异以"回退默认值 / 消除抛错 / 消除控制台警告"为主，仅 1 类（数字型字段标签）朝信息量减少方向变化**，需后续若真出现模型违规输出再按需加宽容忍（如 `text()` 对数字回显 `String(v)`——但那会同时破坏 `|| 默认值` 站点的假值语义，故本卡不做）。
- **删掉了文件级 `eslint-disable`**：`toolConfigs.ts` 此后受 `no-explicit-any` 常规约束，新增 any 会被 lint 拦下——这是防止回摆的主要机制。
- **编排侧与消费侧签名统一**：`ToolDisplayConfig` 与 `ToolDisplaySection` 的 handler 形状一致后，类型断言/鸭子类型的缝不再靠 `any` 兜住；但代价是新增工具配置时，字段读取必须走 `field`/`text`（比裸 `input.x` 长），这是有意用少量书写成本换类型安全。
- **未收敛项有明确出口**：3 处保留项各有已记录的独立路径（判别联合建 `action → payload` 接口；`contentType → prop` 契约建模），不依赖本 note 的结论即可开工。

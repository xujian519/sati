# Agent Note: #806–#830 issue 清扫（依赖环、配置校验、专利确定性能力）

Status: implemented

## Problem

本轮要处理仓库里 12 个 open issue，分两类：

1. 技术债务（#806–#817）：其中 `permission ↔ tool` 运行时值循环使 `src/` 的静态 SCC 长期非零；配置解析辅助函数在 5 个模块各写一份；6 个 IM 通道重复「已创建新会话。」文案；账本里的文件行数会随代码漂移而无人校验；`AgentLoop` 主回路承载了全部阶段逻辑；UI 文件树组件 832 行；`sessionKey`/`sessionId` 命名无边界规范。
2. 专利增强（#830）：M1 anchor 的基础匹配已落地，但 M4（权要 lint）、M6（实施例分块）、M7（pairwise 校准）仍是空白；M2（A26.4 子图）与 M3（权要布局策略）未接线；M5（rubric 评测）需要真实模型调用。

## Decision

- **切环**：把 `PLAN_MODE_ALLOWED_TOOLS`、plan-mode 违规文案从 `src/tool/` 迁到 `src/shared/planModeConstraints.ts`。`permission` 与 `tool` 都依赖 shared，不再互相值引。
- **门禁**：新增 `scripts/check-runtime-cycles.mjs`，用 TypeScript AST 只统计初始化期求值的静态边（忽略 `import type` 与 `await import()`），接入 `pnpm lint`。它比 madge 更贴合「初始化期环」的口径，也避免把刻意的惰性 import 环误报。
- **校验原语**：新增 `src/shared/configValidators.ts`，只放判定/收窄；各配置模块保留自己的 diagnostic code 与 fallback。
- **IM 文案**：导出 `NEW_SESSION_ACK_TEXT`，6 处字面量改为引用；不引入 mapper 形状适配层。
- **claim_lint**：`src/patent/claim-lint/` 做纯函数规则引擎，6 条规则（不确定用语 / 引用基础 / 多项引用 / 前序一致 / 纯功能性 / 编号连续），零 LLM、零 I/O。
- **实施例分块**：`splitEmbodiments` 按标题切块并绑定特征；`buildSpecContext` 超预算时给每个实施例均分预算，避免后续实施例被整段丢弃。
- **pairwise**：`scripts/patent-pairwise-eval.ts` 计算 Kendall τ-b，τ < 0.4 只报告不 fail。
- **账本校验**：`scripts/check-debt-ledger.mjs` 比对 backlog 的「文件 N 行」声明与 `metrics.md` 基线，同一文件取最后一次声明，跳过含 `→` 的历史叙述。
- **AgentLoop 阶段外置（#809）**：`handleNoToolCalls` / `executeToolCalls` 从类方法改为 `noToolCalls.ts` / `toolCallExecution.ts` 的生成器函数，依赖用 `NoToolCallsDeps` / `ToolCallExecutionDeps` 显式注入；主类只保留编排与恢复决策。`AgentLoop.ts` 1151 → 783 行，import 36 → 34，行为与测试不变。
- **A26.4 子图（#830 M2）**：`claim-breadth.ts` 复用 enablement 的 `splitSpecSections`/`buildSpecContext`，`load` + `anchor_evidence` 两节点纯确定性（权项切分、特征切分、说明书连续子串命中），未命中特征显式进入提示块；clarity/support/functional_limit/conclude 走 LLM。注册进 `DOMAIN_GRAPHS` 与输入声明表。
- **权要布局策略（#830 M3）**：新增 `claim-strategy` 原子输出 `claims_strategy` + `claims_tree`；`draft-claims` 在策略表可解析时按从权树**确定性渲染**（不再调用 LLM），损坏/缺失时回退旧路径并写 `claim_strategy_ignored` 留痕。两个撰写 manifest 插入 `claim_strategy` 阶段。
- **撰写 rubric 评测（#830 M5）**：`src/patent/evaluate/cases/disclosure-drafting.ts` 定义五维 100 分 rubric（A26.3 30 / A26.4 25 / 结构 15 / 反套话 15 / 权要布局 15），评分零 LLM：有子图结论时用子图布尔，缺失时走确定性代理，并用 `signalSource` + `unverifiedDimensions` 区分「已核验」与「未跑子图」。20 件金标语料（10 clean / 10 defect）落 `tests/patent/fixtures/drafting-golden/cases.jsonl`；`scripts/patent-drafting-eval.ts` 输出 BatchReport 与非零退出码。基线：clean 10/10 过线均分 94.90，defect 10/10 检出均分 78.08（见 `docs/patent-drafting-eval.md` §4.1）。2026-11-07 补 live 基线（`--live`，Moonshot `kimi-k2.7-code-highspeed`）：20 件信号的 clean 2/10 均分 73.40、defect 9/10 均分 72.79；4 件完整管线的总分 32.18–39.91。差值来自子图从严判定（8 件 clean 的 A26.3 判不充分），不是评分漂移；token 未能量测，已在文档标注。
- **`claim_breadth` 工具入口（#830 收尾）**：`patent_workflow_run` 的 `graph` 枚举补 `claim_breadth`，输入语义为 `claimText` = 权利要求、`input` = 说明书；`graphRun` 走既有 `DOMAIN_GRAPHS`，无新增执行路径。同步更新工具描述、`types.ts` 注释与 `src/patent/graph/README.md`，并按规则重录 llm-replay fixture。
- **UI 巨型组件拆分（#806）**：Top 5 的 5 个 ≥600 行函数全部拆完——`FilesV2.tsx` 832 → 236 行；`useGitPanelController.ts` 704 → 167 行；`ImportFromFolder.tsx` 688 → 156 行；`LlmConfigurationStep.tsx` 633 → 139 行；`AppShellV2.tsx` 632 → 156 行。拆分为职责单一的自定义 hook + 展示子组件，新模块一律 ≤200 行；逐字迁移状态/副作用/事件时序，导出与 props 不变，UI typecheck / eslint / vitest 全绿。
- **会话标识规范（#812）**：见 `docs/notes/implemented/2026-11-07-session-identity-naming.md`。分层固定命名、跨层显式改名、贫血 DTO 保持零方法；不做全局重命名。

## Alternatives considered

- **拆分 `tool/index.ts` barrel 来切环。** 落选。改动面覆盖 16 个 builtin 的导入路径，回归风险远大于收益；把两个纯常量/文案移到 shared 就能让初始化期 SCC 归零。
- **用 madge 作为门禁。** 落选。madge 需要新增依赖，且默认口径会把动态 import 环算进来，而 `toolContext → SubAgentSession` 的动态 import 是刻意的启动优化。
- **在 shared 里做统一的 `readPositiveInt(value, fallback, path, diagnostics)`。** 落选。各模块 diagnostic code、消息文案、fallback 语义不同，强行统一会把差异塞进参数，反而增加耦合。
- **把 QQ / WeCom 的 mapper 也收敛到 `resolveIncomingMessage`。** 落选。两者入参分别是 `groupId/userId` 与 `groupSessionsPerUser`，收敛需要形状适配层；本轮只消灭重复文案，不引入新抽象。
- **claim_lint 直接做成 LLM 原子。** 落选。规则是确定性的，走 LLM 既慢又不可复现；先做纯引擎，原子接线另行处理（会改 inputSchema 并触发 fixture 重录）。
- **把 `claim_breadth` 同时加进 `patent_workflow_run` 的 graph 枚举。** 首轮落选、2026-11-07 补做。落选原因是改枚举即改工具 `inputSchema`，会触发 llm-replay fixture 失配且当时无 key；拿到凭据后按规则真实重录 `deepseek-v4-flash-basic`（单条记录，无伪造），枚举/描述/类型注释/`src/patent/graph/README.md` 一并同步。
- **`claim-strategy` 直接改 `draft-claims` 的既有输出格式。** 落选。旧路径（无策略表）必须保持逐字行为，否则既有 manifest 与评测基线全部漂移；用「有策略表则渲染、无则回退」的分支隔离。
- **`AgentLoop` 一次性按阶段全部拆成独立模块。** 落选。恢复决策（电路断路器、max turns）与主循环强耦合，全部外移只会把状态机切成更多隐式契约；本轮只外置两个最大的纯编排阶段。
- **对 #812 执行全局重命名 / 给 248 个 DTO 加方法。** 落选。wire 字段与序列化契约会同时破裂；先写边界规范并按改动 scoped 收敛。
- **实施例分块时把整个「具体实施方式」重排。** 落选。会改变 prompt 语义与既有评测基线；只在超预算时改变截断分配。
- **pairwise τ 未达标时让 CI 变红。** 落选。样本只有 10 对时 τ 方差大，按计划只做报告与人工抽检。
- **一次性拆完全部 28 个 ≥300 行函数。** 落选。本轮只清 Top 5（≥600 行）；<600 行的函数按 issue 的触发条件随下次改动拆分，避免一次性大范围 diff 稀释评审注意力。
- **M5 先接真实模型跑 live 基线再落 rubric。** 首轮落选、2026-11-07 补跑。落选原因是当时无 key，且 drafting 管线没有可回放的 fixture；先落地确定性 rubric + 已录产物语料，保证评分可离线/CI 复现。拿到凭据后补跑 live 基线（20 件信号 + 4 件管线，Moonshot `kimi-k2.7-code-highspeed`），两种口径分别入库，不用 live 结果替换确定性基线。
- **用 DeepSeek `deepseek-flash` 跑 live 基线。** 落选。该模型对 `response_format` 返回 `This response_format type is unavailable now`，子图与管线阶段会整段失败；改用 Moonshot。脚本保留 `--provider/--model`，换模型须重跑并替换基线数字。
- **live 基线跑全部 20 件完整管线。** 落选。单件管线约 1.5 分钟且产出高度随机，20 件既不经济也不比 4 件代表性子集更能说明问题；信号轮覆盖全部 20 件，管线轮固定 2 clean + 2 defect。

## Consequences

- `src/` 初始化期循环依赖 0 组；新增 `check:runtime-cycles` 与 `check:debt-ledger` 两个可执行门禁。
- 生产代码 `as never` 归零（剩余 7 处均在测试辅助）；`@deprecated` 有明确删除跟踪；IM 新会话文案单点化。
- 专利侧新增确定性单测：claim-lint 11 + 实施例 5 + pairwise 4 + claim-breadth 4 + claim-strategy 9 + drafting-eval 6 + 既有 spec 扩充。
- `AgentLoop.ts` 1151 → 783 行；UI Top 5 巨型组件函数全部 ≤236 行，全仓不再有 ≥600 行的组件函数。
- 唯一一次工具 `inputSchema` 变更：`patent_workflow_run` 的 `graph` 枚举补 `claim_breadth`，llm-replay fixture 已用真实 DeepSeek 重录（`tests/fixtures/llm-replay/deepseek-v4-flash-basic`）。
- **未完成且不静默**：UI 其余 22 个 300–600 行非测试函数按 issue 触发条件随下次改动拆分（见 `docs/technical-debt/backlog.md`）；#830 M5 live 基线只覆盖 20 件信号 + 4 件管线，token/费用未能量测（provider 流式响应无 usage），检索增强与多次重复未做——以上限制已写入 `docs/patent-drafting-eval.md` §4.2 与 `unverifiedDimensions`，未把「没跑」呈现成「通过」。

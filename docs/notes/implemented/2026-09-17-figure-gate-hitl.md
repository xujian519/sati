# Agent Note: 附图核验接成工作流门禁（figure-gate，fail 挂 HITL）

Status: implemented

## Problem

附图的"契约 + 确定性渲染 + 规则核验"三件套早已建成（FigureSpec → 黑白 SVG →
V1/V2/V3/V4/V5/V7/V8/V9），但**核验器从未被自动调用**：`checkFigures` 只被
`patent_figure_check` / `patent_figure_generate` 两个工具按需调用，而 `patent_drafting_v1`
的 `figure_generate` 阶段是**无原子透传阶段**——是否核验完全取决于主代理是否记得调工具。
一份案卷跑完撰写 SOP，"附图合规"这一项可能根本没有被检查过，而结果看起来一样。

结构性原因不是"忘了接"，而是**缺输入契约**：核验要 FigureSpec（生成时有）+ 说明书文本
（定稿时才有），透传阶段只能携带文本，下游拿不到结构化 spec。同 PR 的 sidecar
（`2026-09-17-figure-sidecar-contract.md`）补上了这一半，本笔记补上另一半。

## Decision

新增确定性 gate 原子 `figure-gate`（与 `quality-gate` / `slop-gate` / `clarity-gate` 同构）：
从 sidecar 取回 FigureSpec，与 `state.claims_draft` / `state.spec_draft` 一起跑全量规则，
结论落盘 `figure-check.json`，并把 `figure_generate` 阶段的 `atom` 指向它。

- **目录三级回退**：`state.figure_dir` → 案卷 `data/cases/<caseId>/outputs` → `.sati/figures`
  （与生产工具的默认输出目录一致）；三级皆无 sidecar → `degraded` 并列出已探查的路径，
  不假装"已核验"。`caseId` 经 `WorkflowContext.caseId` 进入 state（`{...ctx}`），无需新增状态键。
- **fail 挂 HITL（决策 D1）**：把 `figure-gate` 纳入 `isApprovalGateHandler`，fail 级抛
  `InterruptStageError`（编号选择：1=确认放行/2=重新生成/3=退回），放行经既有
  `approveStageIds`（manifest 路径）/`grantApproval`（图路径）契约，报告标注"人工强制放行"。
  warn 级（V3/V5/V7-font/V8）报告透传，不阻断撰写。
- **漂移 fail-loud**：sidecar 与 SVG 的图号 / `data-ref` 集合不一致（图被手工改写或 sidecar
  被改坏）→ 直接挂 HITL：漂移下"核验通过"不成立，宁可中断也不给出假保证。
- **无文本层时如实降级判定范围**：`claims_draft`/`spec_draft` 都为空时以 `skipTextRules`
  运行并在报告注明"无说明书文本，V2/V3 未生效"——**不**把图内全部标记判成"未提及"（那会
  制造一批假 fail）。
- **不声明 retry**：本阶段的"修复"发生在主代理的附图生成（工具）侧，回退一个透传阶段不会
  改变产出；有界重试只对能被重跑的阶段有意义。

## Alternatives considered

- **把门做成"审查提示"（warn-only，不中断）** — 落选（评审决策 D1 已定）：附图 fail 级问题
  （图号不连续、图文标记不一致、画幅超出可印区）会让交付物被形式缺陷驳回，"提醒一下"在
  长链路里等于不修；挂 HITL 才有"必须有人看过"的记录，且放行是显式动作。
- **不纳入 `isApprovalGateHandler`，改用自定义"软中断"** — 落选：`isApprovalGateHandler` 是
  两条执行链路（manifest / graph）**共用**的放行判据，绕开它就要在两条链路各写一份放行逻辑，
  正是 `stage-primitives.ts` 记录过的那类漂移；纳入时同步补了"兄弟门不被静默放行"的回归断言。
- **放在 `patent_figure_check` 工具里"顺便"跑并写进结果文本** — 落选：工具是被调用者，是否
  被调用仍由模型决定——这正是本笔记要消除的失效模式。
- **新建独立阶段（如 `figure_check`）而不是给 `figure_generate` 挂原子** — 落选：附图核验与
  附图生成是同一交付动作的两半（核的就是刚生成的那批图），拆成两阶段会让"附图阶段"在
  plan/HITL/检查点里各出现两次，且中间态（生成了但没核）没有意义。
- **核验失败时 retry 回退 `draft_spec`（借 slop-gate 的闭环）** — 落选：附图的 fail 成因
  （画幅、标记、编号）与说明书正文无关，回退重写说明书既解决不了问题，又会把已经定稿的
  说明书重写一遍；正确动作是重出附图（HITL 选项 2，人在环里决定）。
- **找不到 sidecar 时按 V1/V9 判 fail（"没附图就是违规"）** — 落选：发明申请允许无附图
  （实用新型才必须有），而门自身无法可靠区分"本案确实不需要附图"与"该生成却没生成"；
  判 fail 会在合法案卷上造出假拦截。改为 degraded + 明确列出探查路径（诚实降级）。
- **把 `figure-check.json` 写进 transcript 或全局目录** — 落选：留痕必须与案卷产物同址
  （与 sidecar 同理：案卷搬迁后结论随行），且 `inputs_hash` 让"结论 ↔ 输入"可核。

## Consequences

**换来**：附图合规从"看主代理记不记得"变成**每次跑 SOP 必然发生**的确定性步骤——跑到附图
阶段即产出 `figure-check.json`（含 `inputs_hash`），fail 级会中断并进入 HITL 决策；核验结论
与输入内容的对应关系可审计。

**付出**：

- **`figure-gate` 进入"可人工强制放行"的门集合**：`isApprovalGateHandler` 扩容意味着任何
  经 `approveStageIds`/`grantApproval` 的放行都会跨过它——语义是"人已看过并接受"，不是"门消失"。
  门粒度隔离由既有契约（放行标记只进 handler 局部执行态）保证，并新增了兄弟门回归断言。
- **无 sidecar 的案卷会在 `figure_generate` 出现一个 degraded 步骤**（发明案若确实不出附图，
  这是噪声——但比"静默通过"好，且原因串写明了探查过的目录）。
- **核验发生在运行时文件系统上**：目录解析依赖 `process.cwd()`（StageHandler 契约无 cwd 注入），
  以非默认工作目录启动服务时案卷相对路径解析需要 `state.figure_dir` 显式指定。
- 门内**不调模型、不触网**（纯文件 + 纯函数），故无新增的 LLM 路径与 fixture 影响。

## 相关

- 计划：`docs/patent-figure-hardening-plan.md` §3 P0-3（决策 D1）
- 前置：`docs/notes/implemented/2026-09-17-figure-sidecar-contract.md`（本门的输入契约）
- 代码：`src/patent/atoms/handlers/builtin/figure.ts`、`src/patent/workflow/manifests.ts`（`figure_generate`）
- 测试：`tests/patent/figure-gate.spec.ts`、`tests/patent/drafting-sop.spec.ts`（T6 全链路接线）

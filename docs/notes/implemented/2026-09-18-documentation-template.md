# Agent Note: 议题治理规范的自身漂移修正与 `documentation` 模板（#338）

Status: implemented

## Problem

`docs/issue-management.md` 是 2026-09-14 落地的议题治理规范，但它在描述**自身状态**时是错的，且缺一个提交入口（台账 `TD-PROCGATE-007` / issue #338）：

1. **§8 的 checkbox 未回填**：`docs/issue-management.md` §8 与 `docs/development-standards.md` 都把「同步标签实体：`node scripts/sync-labels.mjs`」列为未完成 `[ ]`，而该步骤早已执行——仓库标签与 `.github/labels.yml` 逐条一致（本条落地时实测 39 条）。
2. **提交页看不到治理规范**：`.github/ISSUE_TEMPLATE/config.yml` 的两条 `contact_links` 指向 `CONTRIBUTING.md` 与 `docs/development-standards.md`，没有 `docs/issue-management.md`。新议题提交者因此看不到模板选择、状态机、关闭纪律与过期规则。
3. **`documentation` 标签无模板引用**：`.github/labels.yml` 声明了该类型标签，但模板 frontmatter 只有 `bug` / `enhancement` / `tech-debt`。文档类议题只能用 `bug` / `feature_request` 模板开 ⇒ 自动落上语义不符的类型标签，需人工改标。

三类漂移的**共同形状**是「规范对自己的描述没有下游校验」：checkbox 是不是真的勾了、提交页有没有规范入口，都不是任何门禁的输入；而类型标签的缺口也**刻意不在**门禁里（见下条 Alternatives）。

## Decision

1. **回填两处 checkbox 并附核验证据**，而不是简单把 `[ ]` 改成 `[x]`：`docs/issue-management.md` §8 与 `docs/development-standards.md` 的「仓库设置」条目现在记明"2026-09-18 核验：`gh label list --limit 100` 39 条与 `.github/labels.yml` 逐条一致"。同一段里「（按需）创建版本里程碑」**保持未勾选**并注明"尚无需求，故未建"——未勾选如实反映"该动作未发生"，不是待办遗漏。
2. **`config.yml` 增加指向 `docs/issue-management.md` 的 `contact_link`**（开发标准与贡献指南之间，because 提交议题时最需要的是它）。
3. **新增第四条模板 `.github/ISSUE_TEMPLATE/documentation.md`**（`docs: ` 前缀、`labels: ["documentation"]`、含「影响 scope」节），即 issue 建议的 (a)。选择 (a) 而非 (b)「接受现状并在 §2 写清手工改标」的理由：手工改标是**每次都发生**的成本，而新增模板是一次性成本，且模板 frontmatter 是 GitHub 侧唯一的自动打标入口——把类型交给"人记得改"与规范的自动化方向相反。
4. **`documentation.md` 刻意不含「契约影响」节**：文档议题不改变工具 `inputSchema` / 事件面 / 网关协议，多一个必然勾「不涉及」的节是噪声。边界写在模板末尾的 HTML 注释里（同时改契约的文档改动应改用 `feature_request` / `tech_debt` 模板），避免后来人误判为漏写。
5. **同步规范与注释里的计数**：§2 由"三个模板"改为四条并补上 `documentation.md` 行；§2 的三条「诚实边界」更新为四条模板的口径；`scripts/sync-labels.mjs` 里"补节后三条模板全部参与比对"的注释改为不写死条数。

## Alternatives considered

- **只把 `[ ]` 改成 `[x]`，不写核验证据** —— 落选。同一份 §8 的历史问题正是"勾选状态与实况脱节"，只翻一个符号无法让下一位读者判断该勾选是否可信；写上"哪天、用什么命令、看到什么"才是可复核的。
- **顺带给「类型标签必须被某条模板引用」加一条门禁** —— 落选。`--check` 现有的方向是"模板引用的标签必须已声明"，反向校验会误伤合法用法：`question` / `dependencies` 等标签本就由人工在议题上直接打，要求"每个标签都有模板"会把它们判红。缺口只能靠人（新增类型标签时问一句"谁来打它"），已作为「诚实边界三」写进 §2。
- **把「（按需）创建版本里程碑」一并勾掉** —— 落选。那会让 §8 重新变成"描述与实况脱节"，正是本条要修的病；按需项如实留白并注明原因。
- **在 §2 写"文档类议题用 feature 模板开、手工改标"（issue 建议的 (b)）** —— 落选，理由见 Decision 第 3 条；且 (b) 会让 `documentation` 标签长期停在"声明了但没人自动打"的状态，与 #406 正在推进的"定级/分类半自动化"方向相反。
- **修掉 `docs/notes/implemented/2026-09-16-scope-vocabulary-contract.md` 里已过期的两句**（"不含该节的模板（当前是 `tech_debt.md`）不参与"、"`tech_debt.md` 缺…仍未修"）—— 落选。该 note 自己写明了本仓纪律：note 是不可改写的决策记录（`docs/notes/README.md`），更正由新 note 承载。故本条 note 即为那两句的更正：`tech_debt.md` 已于 2026-09-17（`TD-PROCGATE-003` / PR #335 一线）补上该节，`documentation.md` 于 2026-09-18 加入并**一落地即带**该节 ⇒ 「不含该节的模板不参与比对」这条过滤当前**没有实际对象**（保留给下一个新增模板）。

## Consequences

- **换来**：`documentation` 标签从"声明了没人打"变成**模板自带**，文档类议题一开就落在正确类型上（不再人工改标）；提交页三条 `contact_links` 覆盖贡献流程（`CONTRIBUTING.md`）、开发标准（`development-standards.md`）与议题治理（`issue-management.md`）；§8 的两处 checkbox 与实况一致且**可复核**（带日期与命令）。
- **新模板一落地即受门禁覆盖**，且该覆盖经过**实测**而非推断：`pnpm check:issue-labels` 由「39 个标签，3 个模板」变为「39 个标签，**4** 个模板」；负控制两组——从 `documentation.md` 删掉一行勾选项（`desktop`）⇒ 被模板间比对拦下（`缺勾选项「desktop」（与 bug_report.md 不一致）`）；加一行未声明选项（`ghost`）⇒ 同时被模板↔标签与模板间两条拦下。
- **分类器联动亦经实测**：把新模板正文（勾选 `ui` 与「其他: 议题治理」）喂给 `node scripts/classify-issue.mjs`，输出 `scope:ui`、`scope:other`、`status: triage`——「影响 scope」节确实被投影成标签，新模板不是装饰。
- **付出**：模板家族从三条变四条，§2 的表格与「诚实边界」段落需要跟着改（本轮已改）；`bug_report.md` 的「契约影响」节仍少 i18n 文案与 UI 渲染两项，这处漂移**依旧**没有门禁守（诚实边界二，本轮未决）。
- **仍未处理**：`.github/labels.yml` 里其他"声明了但无模板引用"的类型标签（`question` / `dependencies` 等）按设计由人工打，不在本条范围；版本里程碑仍未创建（无需求）。

# Sati 议题（Issue）管理规范

> **定位**：本文件是 Sati 议题治理的**明细层**，与 `docs/development-standards.md`（代码门禁）并列——那份管"代码怎么进仓库"，这份管"问题怎么进来、怎么流转、怎么被记住"。
>
> **目标一句话**：让 issue 做到**事事有记录、记录有状态、状态可追溯**——它既是贡献者的入口，也是项目数年后的决策档案。
>
> **与既有体系的关系**：议题不是第二套记录系统。**决策**归 `docs/notes/`，**技术债**归 `docs/technical-debt/`，议题是它们的**入口与讨论现场**——关闭时把结论推进对应的家，而不是留在议题里沉底。
>
> **本文档的诚实边界**：每条规则标注它是**机器强制**还是**人工约定**。GitHub 仓库设置（标签实体、milestone）无法用仓库文件完全强制，只能用脚本同步——不把"约定"伪装成"门禁"。

---

## 1. 标签体系（单一事实源：`.github/labels.yml`）

标签是议题的**状态载体**。四个维度，一个议题可同时带多个维度，但同一维度至多一个：

| 维度 | 前缀 | 取值 | 谁来打 |
|---|---|---|---|
| 类型 | 无 | `bug` `enhancement` `documentation` `tech-debt` `question` `dependencies` … | 模板自带 / 人工 |
| 状态 | `status:` | `triage` `in-progress` `blocked` | 自动补 `triage`，之后人工推进 |
| 优先级 | `priority:` | `p0` `p1` `p2` `p3` | **半自动**：模板「严重级」勾选 → 自动（#406）；未勾选时人工在分诊时定 |
| 作用域 | `scope:` | `agent` `ui` `patent` `desktop` … 提交 scope 词表的**粗粒度子集** | **自动**（见 §5） |

**状态机**（终态由**关闭**表达，不设 `status: done`——避免"标签说完成、议题还开着"的双写）：

```
status: triage ──→ status: in-progress ──→ 关闭（完成 / wontfix / duplicate / invalid）
                └→ status: blocked ───────┘   （解除阻塞后回 in-progress）
```

**规则与机器验证**：

| 规则 | 家 | 机器验证 |
|---|---|---|
| 标签集合的唯一权威是 `.github/labels.yml` | 该文件本身 | — |
| 清单自身合规（名唯一、color 为 6 位 hex、描述非空且 ≤100 字符） | — | `pnpm check:issue-labels`（挂 `pnpm lint`） |
| `status:` / `priority:` 取值在本节状态机与优先级表内（如 `status: done`、`priority: p9` 即红） | 本节 §1 状态机 + 优先级表 | 同上（`scope:` 取值不在此列——由下一条双向校验兜底） |
| 模板 `labels:` 引用的标签必须已声明 | 各模板 frontmatter | 同上（未声明即红） |
| 模板「影响 scope」勾选项 ↔ `scope:*` 标签双向一致 | 模板 + 清单 | 同上（任一方向多出即红） |
| 各模板「影响 scope」勾选项**彼此**一致 | 各模板（GitHub 无法共享片段 ⇒ 同一份清单必然各存一份） | 同上（只改其中一条模板即红） |
| 模板「严重级」勾选项 ↔ `priority:*` 标签双向一致（#406） | 模板 + 清单 | 同上（`P4` 这类认不出的选项**原样保留**后被本行拦下，不静默丢弃） |
| 各模板「严重级」勾选项**彼此**一致 | 各模板 | 同上（当前只有 `tech_debt.md` 有该节，跨模板比对为 no-op；规则先就位） |
| `scope:*` ⊆ 提交 scope 词表（`other` 除外；**反向不成立**） | 提交侧词表由 `.github/labels.yml` **派生** | `scripts/open-pr.test.mjs`（派生 ⇒ 漂移在结构上不可能） |
| 仓库标签实体与清单一致 | GitHub 仓库设置 | `node scripts/sync-labels.mjs`（**人工触发**，幂等 upsert） |

> `sync-labels.mjs` 不挂 CI：写仓库标签是配置操作，需要 `gh` 凭据与写权限，且 CI 无权代改仓库设置。

**作用域表是人工维护的粗粒度表**：`scope:*` 刻意**不**与 `src/` 目录一一对应——issue 面要的是"用户可感知的模块"。绝大多数源码子模块（`adapters` `context` `ui-server` `session` `permission` …）与流程性作用域（`ci` `scripts` `deps` `release` `techdebt` …）**刻意不收**，归口是 `scope:other`（其描述即"未列入上述模块的其他作用域"）。这不是缺口而是取舍：作用域列表要长到覆盖全部提交 scope，就等于把源码目录树搬进 issue 模板。

新增一项时**必须回答的两个问题**（人工判断，不设机器判据——源码目录与产品模块不是一一映射，无法从目录名机械推导）：① 它是**用户可感知的模块**，而非源码目录或流程？② 它有**独立交付边界**（独立 workspace 包 / 独立命名 CI job / 独立发布流程）？两项都成立才收。本轮据此只补了 `desktop`——它是唯一三者齐备的模块（`@sati/desktop`、CI job `Desktop (Windows) build & lint`、`apps/desktop/RELEASING.md`）；`adapters` `context` `ui-server` `ci` `scripts` 不满足 ②（或不属于 ①），故**不收**。

**契约是单向包含，不是同名**：每个 `scope:*` 都必须能被提交侧词表识别（否则按该模块命名的分支推导不出 scope），但提交面允许更细的切分（`team` `extension` `session` `workflow` `web` …）。`other` 是**标签侧独有**的兜底取值，任何提交都不该带这个 scope。这条契约由派生实现保证：`scripts/open-pr.mjs` 的词表从本清单算出来，不另抄一份。

**优先级定义同源**：`p0`–`p3` 的含义直接沿用 `docs/technical-debt/README.md` §严重级定义，不另立一套——同一个项目里不应该有两套优先级语言。

---

## 2. 议题模板（`.github/ISSUE_TEMPLATE/`）

四个模板强制报告者补齐关键信息，**禁用空白议题**（`config.yml: blank_issues_enabled: false`）：

| 模板 | 标题前缀 | 强制信息 |
|---|---|---|
| `bug_report.md` | `bug: ` | 复现步骤、预期/实际行为、**影响 scope**、**契约影响**、环境 |
| `feature_request.md` | `feat: ` | 价值与动机、现状与痛点、期望方案、**影响 scope**、契约影响、验收标准 |
| `tech_debt.md` | `tech-debt: ` | **触发还债条件**（不写不接）、**严重级**、关联决策记录、**影响 scope**、**契约影响** |
| `documentation.md` | `docs: ` | 位置（文件 + 章节/行号）、复现步骤、预期/实际行为、**影响 scope** |

四个设计要点：

- **「契约影响」节是 Sati 特有的高价值字段**——它把三条会在 CI 阶段咬人的契约（工具 `inputSchema` 改动的 llm-replay 失配、事件面改动的事件矩阵门禁、网关协议版本化）提前到提案阶段。勾选它等于承认"这个改动要付额外门禁成本"。
- **`documentation.md` 刻意不含「契约影响」节**：文档议题本身不改变 `inputSchema` / 事件面 / 网关协议，多一个必然勾「不涉及」的节只是噪声。若某项文档改动**同时**要动这些契约（例如文档化的同时要重录 fixture），该议题就不是纯文档议题，应改用 `feature_request` / `tech_debt` 模板登记——这条边界写在新模板的末尾注释里，避免后来人误以为漏写。
- **「影响 scope」节是自动化的输入**，不是装饰——它被 §5 的分类器翻译成 `scope:*` 标签，改动其选项会同时触发标签门禁。该节在每条模板里各存一份（GitHub 无法共享片段），所以门禁同时比对**模板↔标签**与**模板↔模板**。新增模板必须带该节，否则它既打不出 `scope:*`，也不会被模板间比对发现（见下方诚实边界一）。
- **分类（类型标签）由模板 frontmatter 承担**：`documentation.md` 自带 `labels: ["documentation"]`。补这条模板的直接动因是——`documentation` 标签此前无任何模板引用，文档类议题只能用 `bug` / `feature_request` 模板开，于是自动落上 `bug` / `enhancement`，语义错位且需人工改标。

**新增模板的纪律**：模板的 `labels:` 必须已在 `.github/labels.yml` 声明；scope 勾选项必须与 `scope:*` 标签集合一致，且与其它模板的勾选项**彼此一致**。三条都由 `pnpm check:issue-labels` 拦。

> **诚实边界一：`tech_debt.md` 曾长期缺「影响 scope」节**（`TD-PROCGATE-003`，2026-09-17 补）——期间所有技术债议题零 `scope:*`，而本节 §1 却称作用域是「自动」的。这段历史值得留着，因为它揭示了门禁的一个盲区形状：**「模板缺整节」不会被任何校验发现**，缺少的那一节连比对对象都不存在。补齐后四条模板全部参与模板间比对（`documentation.md` 于 2026-09-18 加入，带该节；其参与方式已实测：删一行勾选项即被模板间比对拦下、加一行未声明选项即被模板↔标签比对拦下）。
>
> **诚实边界二：带「契约影响」节的三条模板，该节选项并不一致**——`bug_report.md` 4 项，`feature_request.md` 与 `tech_debt.md` 6 项（多出 i18n 文案、UI 渲染两条）；`documentation.md` 则**刻意不带**该节。该节**不产生标签**，因此没有模板间一致性校验，这处漂移不会被 `pnpm check:issue-labels` 发现（`bug_report.md` 是否该补齐这两项，未决）。这与上一条构成对照：「影响 scope」节因有下游消费者（分类器）而被门禁看重，「契约影响」节没有下游消费者，于是同为多模板重复内容却无人守。
>
> **诚实边界三：类型标签"声明了却无模板引用"不会被任何校验发现**（#338）。`documentation` 标签在 `.github/labels.yml` 里存在了很久，但四条模板的 frontmatter 分别是 `bug` / `enhancement` / `tech-debt`——于是文档类议题只能用 `bug` / `feature_request` 模板开，自动落上语义不符的类型标签、需人工改标。`--check` 校验的是"模板引用的标签必须已声明"这**一个方向**，反向（已声明的标签是否被某条模板引用）刻意不校验：`question` / `dependencies` 等标签本就由人工在议题上直接打，要求"每个标签都有模板"会把这些合法用法判红。因此这条缺口只能靠**人**在新增类型标签时问一句"谁来打它"，与上两条同属"门禁看不见的形状"。

---

## 3. 分诊（Triage）：让状态追上现实

**节奏（人工约定，非门禁）**：新议题由 §5 自动落在 `status: triage`；维护者批量过一遍（不必即时），对每个议题完成三件事——

1. **确认**：可复现 / 需求成立吗？否则打 `invalid` 或 `duplicate` 并说明理由后关闭。
2. **定级**：打 `priority: pN`（含义见 §1）。
3. **推进**：认领则改 `status: in-progress`；等外部条件则改 `status: blocked` 并在正文写明**等什么**。

**不设硬性 SLA**：本项目管理力量有限，承诺"48 小时响应"然后做不到，比不承诺更伤贡献者。诚实的分诊目标是"不让任何议题停在 `triage` 无人看管"，而非"多快看完"。

**分诊的产出是标签变化，不是评论**：状态与优先级必须落成标签——评论会被埋，标签可筛选。

---

## 4. 与其它机制的联动

### 4.1 PR 关联（机器强制）

PR 必须能回溯到来源，由 CI job `pr-traceability` 强制（实现见 `.github/scripts/check-pr-issue.mjs`，自测见 `check-pr-issue.test.mjs`）。写 `Closes #123` / `关联 Issue: #123` / 债编号 `TD-*-*` / 显式声明「无关联 issue」任一即可。

`Closes #123` 在 PR 合并时**自动关闭议题**——这是最省事也最不易遗漏的关闭方式，优先使用。

### 4.2 提交关联（人工约定）

commit message 中引用议题编号（如 `fix(gateway): 修正握手超时判断 (#123)`）使"问题演变过程"可回溯。

**这里刻意不加 hook**：`commit-msg` hook 已强制 Conventional Commits（见 `scripts/check-commit-msg.mjs`），再叠一层引用校验会打断 `chore` / `release` 类提交的合法场景；而"PR 必须可回溯"已在 §4.1 从更可靠的层面强制。

### 4.3 里程碑（人工约定 + 脚本创建）

按版本组织议题，回答"这个版本还剩什么没做完"：

- 命名跟随版本号（`node scripts/bump-version.mjs` 产出的 `vX.Y.Z`），**不为"修完为止"的长期项设里程碑**。
- 有 milestone 的议题**豁免自动关闭**（见 §6）——已排期即视为活跃。
- 里程碑创建是仓库设置操作（`gh api` 或网页），无仓库内文件可声明。

**不使用 GitHub Projects 看板**：本项目状态维度已由 `status:*` 标签表达，"标签即看板"（按 `status: in-progress` 筛选就是 In Progress 列）。引入看板会制造标签与卡片两套状态，需要同步且必然漂移。理由与备选见决策记录。

### 4.4 决策记录（机器强制的是 note 本身，不是关联）

议题是决策的**讨论现场**，`docs/notes/` 才是决策的**家**（AGENTS.md 铁律 7：非平凡变更同 PR 带 note，含 `## Alternatives considered`）。

**关闭一个"为什么这么做"类议题时，把结论推进 note 并在议题里留链接**——议题会沉底，note 不会。`tech_debt` 模板的「关联决策记录」字段就是这个习惯的入口。

---

## 5. 自动化（`.github/workflows/`）

| workflow | 触发 | 做什么 | 机器验证 |
|---|---|---|---|
| `issue-triage.yml` | `issues: [opened, edited]` | 解析「影响 scope」勾选 → 打 `scope:*`；解析「严重级」勾选 → 打 `priority: pN`（#406）；无状态标签则补 `status: triage` | `scripts/classify-issue.test.mjs`（负控制：不得越界读取「契约影响」/「触发还债条件」等节的复选框） |
| `stale.yml` | 每周一 + 手动 | 90 天无活动标 `stale`，再 30 天关闭；`in-progress`/`blocked`/`help wanted`/`good first issue`/`pinned`/有里程碑者豁免 | — |
| `ci.yml` → `pr-traceability` | `pull_request` | PR 必须可回溯到议题/债编号 | `check-pr-issue.test.mjs` |

**分类器只增不减，而 `scope:*` 与「严重级」推出的 `priority:*` 都是正文的投影**——`classifyIssue()` 每次运行都从正文重新推导，因此四类标签的可逆性并不相同：

| 标签 | 是否由正文推导 | 人工摘掉标签后会怎样 |
|---|---|---|
| `scope:*` | **是**（每次运行重推） | **会被加回来**：只要正文勾选还在，下一次标题/正文编辑（`edited` 事件）就会重新打上 |
| `priority:*` | **仅当正文含「严重级」节且已勾选**（#406） | 同上——**但只在正文确实勾了级别时**；没有该节或没勾选（bug / feature / doc 议题，以及未定级的债务议题）时仍是「摘掉即生效」 |
| `tech-debt` | 否 | 摘掉即生效，脚本永远不会补 |
| `status:*` | 否 | 摘掉即生效；但**所有**状态标签被摘光时会补回 `status: triage`（空白状态回到待分诊，刻意行为） |

⇒ **撤销一个误打的 `scope:*`（或「严重级」推出的 `priority:*`），正确动作是两步：取消正文勾选 + 人工摘掉标签。** 只摘标签会在下一次编辑时被加回来。反向也成立：**取消勾选本身不会摘掉已打的标签**（分类器从不删标签），它只影响后续运行是否重新打上——所以「只增不减」的准确含义是"相对正文推导只增不减"，而不是"标签一旦打上就不可逆"。

**`priority:*` 多两条专属规则（#406）**，都写在分类器里并有负控制：

1. **同一维度至多一个标签**：正文多选时取**最严重**的一档（`P0` → `P1` → `P2` → `P3`），而不是打出多个（§1 的维度不变式）。
2. **已有 `priority:*` 时不加第二个**：分诊结论优先于模板勾选。所以人工在分诊时定过级的议题，不会被报告者的勾选覆盖成两档；反过来，要让勾选生效就得先摘掉人工那档。

**分类器只做"能机械判定"的部分**：确认与派发仍由人做；**定级**在报告者勾了「严重级」时由勾选翻译而来，未勾选时仍由人在分诊时定——自动化把"有没有定级"这一维变成有兜底的，但不替人判断该定哪一级。

---

## 6. 噪音与债务治理（人工约定）

| 情形 | 处置 | 硬性要求 |
|---|---|---|
| **僵尸议题**：长期无响应且无法复现 | 标 `stale` 说明后关闭（`stale.yml` 自动执行，人工亦可提前） | 关闭语必须写明"评论即可 reopen" |
| **过大的议题** | 拆成子任务：正文用 `- [ ]` 任务列表，或拆为独立议题并互相链接 | 拆出的子议题须回链母议题 |
| **重复议题** | 打 `duplicate` 并指向**保留**的那个；先搜索再开新议题 | 关闭语必须给出保留项的编号 |
| **不予处理** | 打 `wontfix` 并**写明理由** | 若属设计使然而非缺陷，理由须落成 `docs/notes/` 决策记录（`docs/technical-debt/README.md` 同款纪律） |
| **已解决的旧议题被刷屏** | 锁定（Lock）并说明原因 | 只在确无后续讨论价值时锁——锁定会同时冻结"重新打开"这条恢复路径 |
| **超范围提问** | 打 `invalid` 并指向正确渠道（Discussions / 群聊） | 关闭语给出替代去处 |

**搜索优先**：开新议题前先搜历史（含已关闭）——已关闭的议题是**结论**，不是过期信息，其中常有"这个坑我们已经踩过"的答案。

---

## 7. 关闭纪律：留一句结论

**关闭议题时不要只点 Close。** 至少留下一句结论，让后来者不必重读整条讨论串：

```markdown
结论：<根本原因是什么 / 为什么不做>
处置：<怎么修的 / 指向哪个 PR / 哪条决策记录>
```

具体到各类终止原因：

- **修复完成**：根因 + 修复 PR +（若涉设计取舍）决策记录链接。
- **不予处理（wontfix）**：为什么不做；设计使然者附 note 链接。
- **重复（duplicate）**：保留项编号。
- **无效（invalid）**：为什么无法复现或超出范围 + 替代去处。
- **过期（stale）**：由 `stale.yml` 自动附标准文案，人工关闭时同样适用本纪律。

**这是人工约定，不是门禁**——能否强制？理论上可加"关闭时 body 长度校验"的 Action，但那会把"写一句真诚的结论"变成"凑够字数"。此类规则的可靠性来自维护习惯，不来自校验器；把它伪装成门禁只会生产填充文字。

---

## 8. 落地清单与验证

**仓库文件（随 PR 生效，机器强制）**：

- [x] `.github/labels.yml` — 标签单一事实源
- [x] `scripts/sync-labels.mjs` + `.test.mjs` — 同步器与门禁（`--check` 挂 `pnpm lint`）
- [x] `scripts/classify-issue.mjs` + `.test.mjs` — 分类器
- [x] `.github/workflows/issue-triage.yml` — 自动打标签
- [x] `.github/workflows/stale.yml` — 过期治理
- [x] 本文件 + 决策记录 `docs/notes/implemented/2026-09-14-issue-management.md`

**仓库设置（需手动执行一次）**：

- [x] 同步标签实体：`node scripts/sync-labels.mjs` —— **已完成**（2026-09-18 核验：`gh label list --limit 100` 得 39 条，与 `.github/labels.yml` 的名称/color/description 逐条一致；`pnpm check:issue-labels` 同口径绿）
- [ ] （按需）创建版本里程碑：`gh api repos/xujian519/sati/milestones -f title=vX.Y.Z` —— **尚无需求，故未建**（保持未勾选即如实反映"该动作未发生"，不是待办遗漏）

**验证命令**：

```sh
pnpm check:issue-labels                        # 清单与模板一致性门禁
node --test scripts/sync-labels.test.mjs       # 门禁自测（含双向漂移、模板间漂移的负控制）
node --test scripts/classify-issue.test.mjs    # 分类器自测（含越界读取的负控制）
node --test scripts/open-pr.test.mjs           # 提交 scope 词表派生（含包含关系与重叠判定）
node scripts/sync-labels.mjs --check           # 同上，直接跑
```

---

## 附录：本文档在规范分层中的位置

| 层 | 载体 | 关系 |
|---|---|---|
| 陈述层 | `AGENTS.md` 铁律 10 | 1–3 行摘要 + 链接本文件 |
| 明细层 | **本文件** | 议题治理的规则与边界 |
| 明细层（并列） | `docs/development-standards.md` | 代码门禁；议题落地为 PR 后由它接管 |
| 决策层 | `docs/notes/` | 议题关闭时的结论去向 |
| 执行层 | `.github/workflows/` + `scripts/*` | 机器拒绝违规 |

# Agent Note: 作用域词表契约（单一事实源 + 投影语义）

Status: implemented

## Problem

议题治理的规范与实际实现之间有**三处不一致**，且三处都各自造成了具体后果（`docs/technical-debt/backlog.md`
`TD-PROCGATE-005` / issue #334）：

1. **「自动打错的标签，人工摘掉即可，脚本不会再打回」对 `scope:*` 不成立。**
   `classifyIssue()`（`scripts/classify-issue.mjs`）每次运行都从正文「影响 scope」节重新推导 scope，
   而 `issue-triage.yml` 的触发条件是 `issues: [opened, edited]`。人工摘掉 `scope:ui` 后，只要正文
   勾选仍在，**下一次标题/正文编辑就会把它加回来**。真正「摘掉即生效」的只有不从正文推导的
   `priority:*` 与 `tech-debt`。这句话同时写在 `docs/issue-management.md` §5、`.github/labels.yml`
   头注（隐含）与 `docs/notes/implemented/2026-09-14-issue-management.md`。

2. **「`scope:*` 与提交 scope 同名」不成立。**
   实测 `main` 全部 2628 个提交的 scope 频次：`ui 233 / patent 133 / agent 91 / desktop 61 / deps 50 /
   gateway 48 / team 30 / context 29 / cli 29 / skills 25 / cron 25 / tools 23 / memory 23 / ui-server 19 /
   wcb 18 / settings 18 / adapters 14 / session 14 / …`，去重后约 180 个不同取值，其中**绝大多数没有
   对应的 `scope:*` 标签**。两个词表既非相等、也非互相包含：`other` 是标签独有，`desktop`/`team`/`web`
   等是提交独有。台账 §35 已如实记下后果——**12 条债务 issue 落在 `scope:other`**。

3. **词表存在第三份手抄。**
   `scripts/open-pr.mjs` 的 `KNOWN_SCOPES` 是 21 项硬编码，与 `.github/labels.yml` 的 `scope:*`
   部分重叠（15 项）、部分独有（6 项），彼此无任何门禁约束。这与本仓**已做出的决策**直接冲突：
   `docs/notes/implemented/2026-09-14-issue-management.md` 明确否决「把标签直接硬编码在脚本与
   workflow 里」，理由正是"模板、脚本、仓库设置三处各写一份标签名，改一处就静默失效"。

**核码时对 issue 正文的四处更正**（正文给的是当日快照，已漂移）：

| issue #334 的说法 | 核码结论 |
|---|---|
| 提交 scope 频次 `cli 21 / ui 16 / patent 15 …` | 那是**浅历史/截断**快照；`main` 全历史实测 `ui 233 / patent 133 / agent 91 …`，量级差一个数量级 |
| 「14 个 scope 无对应标签」，逐个点名 | 实为约 **180 个不同取值**；`skills`/`tools`/`settings`/`wcb`/`chat`/`weixin`/`im`/`standards` 等未被点名的更高频项同样无标签 |
| 「一个 `refactor(adapters)` **PR** 无法被任何 `scope:` 标签筛选」 | PR 从不打 `scope:*` 标签（没有任何生产者）；受影响的只有 **issue** 侧筛选 |
| 建议「补齐提交侧高频 scope 至少 `adapters`/`desktop`/`context`」 | `context`(29) 与 `adapters`(14) 在有独立门禁/独立目录的模块里并不突出；台账 §35 的候选清单（`ci`/`scripts`/`desktop`/`ui-server`/`adapters`）与之**互不一致** ⇒ 分类学本身未定，见 Decision 第 5 条 |

## Decision

**1. 提交 scope 词表改为从标签清单派生，消除第三份手抄。**
`scripts/open-pr.mjs` 新增 `loadKnownScopes(root)`：
`KNOWN_SCOPES = labels.yml 的 scope:*（剔除 other）∪ COMMIT_ONLY_SCOPES`。
`COMMIT_ONLY_SCOPES`（`team`/`extension`/`session`/`workflow`/`web`）显式声明并写明理由——
它们是提交历史的真实取值，但不属于「用户可感知的模块」。派生后词表规模与改造前**完全一致（21 项）**，
即行为零变化。惰性求值（首次推导标题时才读清单）以保持"被 import 时不触碰文件系统"的仓内约定。

**2. `other` 明确为标签独有取值，不进提交词表。**
分支 `feat/other-x` 若把 `other` 当 scope，会产出 `feat(other): x`——一个不表达任何模块的 scope。
导出 `LABEL_ONLY_SCOPE` 并在用例中绑定两侧。

**3. `pnpm check:issue-labels` 新增「模板之间勾选项必须一致」。**
GitHub 的 issue 模板无法共享片段，同一份 16 项清单在 `bug_report.md` 与 `feature_request.md` 里
**各存一份**；而既有校验比对的是模板**并集**，因此「只改了其中一条模板」此前**完全无门禁**。
新增的比对以排序后第一条含 scope 节的模板为基准，双向报警（缺项/多项）。不含该节的模板
（当前是 `tech_debt.md`）不参与——它本来就不产生 scope 标签。

**4. 修正规范措辞，让「规范所述 = 实现所为」（issue 的预期行为）。**
`docs/issue-management.md` §1/§2/§5、`.github/labels.yml` 头注、`.github/workflows/issue-triage.yml`
头注改为主张**真实的**语义：`scope:*` 是正文的**投影**（只增不减、每次重推），撤销误打须
「取消勾选 + 摘标签」两步；词表契约是**单向包含**（每个 `scope:*` 必须能被提交侧识别，反向不成立），
不是「同名」。

**5. 给「哪些模块配 `scope:*`」一个成文判据，并据此只补 `desktop`。**
判据两道：① 它是**用户可感知的模块**（而非源码目录或流程）；② 它有**独立交付边界**（独立 workspace
包 / 独立命名 CI job / 独立发布流程）。`apps/desktop` 是唯一三者齐备者：`@sati/desktop`（`pnpm-workspace.yaml`）、
CI job `Desktop (Windows) build & lint`、`apps/desktop/RELEASING.md`。故补 `scope:desktop`，并在
`scope:ui`（"Web UI / 组件 / i18n"）之外单列——`apps/desktop` 是 Electron 应用，不是 web UI。
`adapters`/`context`/`ui-server`/`ci`/`scripts` **按判据不收**：issue 面要"用户可感知的模块"，
不是源码目录的一一映射，细粒度归 `scope:other`。

**6. 分类器保持「只增不减」，不引入任何状态。**
`classifyIssue()` 的输入仍然只有「正文 + 现有标签」，语义写进文档；`scope:*` 的投影性质
由用例钉死（`scripts/classify-issue.test.mjs`）。

## Alternatives considered

- **让分类器记录「已人工摘除」状态，不再回填**（issue #334 的建议之一）— 落选。要区分"人工摘除"
  与"从未打过"，就得在 issue 正文里埋标记或引入外部存储。埋标记会污染用户可见正文、且标记本身
  也是一份需要同步的状态；外部存储则是本仓明确回避的方向（治理状态全部落在仓库文件与标签上）。
  代价（一处措辞不准确）远小于引入状态机的代价。

- **让分类器对称化：取消正文勾选即摘掉标签** — 落选。看起来更"干净"，但它使**静默删除**成为可能：
  维护者刻意给某议题补打一个与其正文不符的 `scope:*`（作为人工覆盖）后，任何一次无关的正文编辑
  都会把它悄悄摘掉。分类器"不替人决策"是本模块的显式设计边界（`issue-triage.yml` 头注），
  删标签比加标签更接近决策。折中（只在标签由自动化打上时才删）需要记录"谁打的"，即回到上一条。

- **保留 `KNOWN_SCOPES` 硬编码，改为加一条一致性测试** — 落选。那是"测两份注定漂移的副本"：
  测试与实现同源时会一改俱改；不同源时又只是把第 4 份词表搬进测试文件。派生让漂移在**结构上不可能**，
  比断言"两者相等"强。

- **反过来把提交 scope 收敛到标签词表**（issue 给的第二个方向：只允许 16 个模块 + `other` 作提交
  scope）— 落选。提交 scope 是**写作者的自由文本**，其作用只是让 PR 标题表达改动面；把它收窄到
  16 个值会让 180 个真实取值中的绝大多数失去表达，且无法用门禁真正强制（`commit-msg` hook 只校验
  格式）。提交面允许比 issue 面细，是这次契约定为**单向包含**的直接原因。

- **把 `adapters`/`context`/`ui-server`/`ci`/`scripts` 等高频 scope 一并补成标签** — 落选。两个在仓
  记录里互相冲突的候选清单（issue 的 `adapters`/`desktop`/`context` vs 台账 §35 的
  `ci`/`scripts`/`desktop`/`ui-server`/`adapters`）说明分类学未被决定，照任一份补都是在无判据下仲裁。
  本轮把判据写进 §1、只补满足判据者，并把"是否扩充"保留为后续可复核的决定（扩充成本已降到
  一行 `labels.yml` + 两条模板）。

- **把 `other` 也纳入提交词表**（"既然标签里有，就统一"）— 落选。`other` 的语义是"**未列入上述模块**的
  其他作用域"，是一个**兜底**而非模块名。纳入后 `feat/other-x` → `feat(other): x` 会产出无信息量的 scope，
  并使"该 PR 属于 other 模块"成为一个看似可筛选实则无意义的分类。

- **把 `COMMIT_ONLY_SCOPES` 也写进 `.github/labels.yml`（加注释标记为"不生成标签"）** — 落选。
  那会让一个"给 issue 打标签"的清单承担第二种语义，且 `--check` 的双向校验需要为它开洞
  （既不能有勾选项、又被当作标签集合成员）。留在 `open-pr.mjs` 里显式声明 + 用
  `duplicateScopeDeclarations()` 拦住与标签的重叠，语义更单一。

- **把词表抽成 `scripts/scope-vocabulary.mjs` 供两侧 import** — 落选。引入一个只有两个消费方、
  且其中一个（`sync-labels.mjs`）根本不需要词表的新模块，是把依赖关系复杂化。`labels.yml`
  已经是事实源，直接读它比经一层中间模块更短。

- **给 `sync-labels.mjs --check` 再加一条「每条模板都必须含『影响 scope』节」** — 落选（本轮）。
  当前 `tech_debt.md` 缺该节是有记录的缺口（`TD-PROCGATE-003` / issue #335），此刻加硬性要求会让
  一条已知在办的工作变成红灯。改为只比对**含该节的**模板，缺陷仍由台账跟踪。等 #335 落地后可再把
  它升级成"必含"。

- **在构建期生成模板里的勾选项**（消除 16 项 × N 份的重复）— 落选。GitHub 的 issue 模板是仓库里的
  markdown 文件，没有任何预处理好读取的生成入口；为它加一个生成步骤会把"改模板"变成"改生成器 + 跑生成"，
  成本高于收益。一致性门禁已能拦住漂移，重复本身无害。

## Consequences

**换来**：提交 scope 词表只有一份事实源（新增 `scope:*` 标签后 `open-pr.mjs` 自动识别，不可能漏）；
「模板间漂移」从无门禁变成 lint 阶段红灯；规范里三处会被照着做错事的措辞被改成实测语义，并由
可执行用例钉住（`scripts/classify-issue.test.mjs` 的投影语义 3 例 + `scripts/open-pr.test.mjs` 的
派生契约 9 例 + `scripts/sync-labels.test.mjs` 的模板间比对 5 例）；桌面端议题不再只能落
`scope:other`（`scope:desktop` 是唯一按成文判据补上的模块）。

**付出**：`open-pr.mjs` 现在依赖 `.github/labels.yml` 可读（读取失败即抛错，方向是 fail-loud——
不会退化成"词表为空 ⇒ 标题静默丢 scope"）；`labels.yml` 的 `scope:*` 与 `COMMIT_ONLY_SCOPES`
不得重叠，因此**今后把某个提交 scope 提升为标签时，必须同时删掉提交独有表里的旧声明**（由
`duplicateScopeDeclarations()` 拦，这正是 M2 注入要验证的转换）；`labels.yml` 与两条模板的勾选项
今后必须**同时**改（`pnpm check:issue-labels`），且新增标签后仍需**人工**跑一次
`node scripts/sync-labels.mjs` 把仓库标签实体同步过去（CI 无仓库设置写权限）。

**未处置**（如实登记，不claim已修）：

- `docs/notes/implemented/2026-09-14-issue-management.md` 里的旧措辞未回改——note 是历史，
  按 `docs/notes/README.md` 纪律不应改写既有 note 的结论；本条 note 即为更正。规范正文
  （`docs/issue-management.md`，即"当前事实源"）已改。
- `feature_request.md` 的「影响 scope」节此前从未出现在 `docs/issue-management.md` §2 的表格里
  （模板有、规范漏记），本轮补上表格行；该节本身一直存在且已受门禁覆盖。
- `tech_debt.md` 缺「影响 scope」节仍未修（`TD-PROCGATE-003` / issue #335）；本轮的门禁
  **刻意不**要求各模板必含该节，见 Alternatives。
- 「是否扩充 `scope:*`」仍是开放决定：台账 §35 提到的 `ci`/`scripts`/`ui-server`/`adapters`
  等按 §1 判据不收，若有需要应按判据另开决策。

## 负控制（7 组注入，逐条对名核对）

对同一条判据做"注入退化 → 跑目标 spec → 记录转红名单 → 从 `/tmp/334/` 备份还原"（**不用**
`git checkout --`，它回到 HEAD 会抹掉本轮未提交的实现改动）。还原后三个文件按 SHA-256 校验
逐字节一致，55 例复绿。

| # | 注入的退化 | 预期转红 | 实际转红 | 命中 |
|---|---|---|---|---|
| M1 | 派生时漏掉一个标签 scope（`patent`） | 3 | 3 | ✅ |
| M2 | `desktop` 留在提交独有表（提升为标签后忘删旧声明） | 1 | 1 | ✅ |
| M3 | `other` 未被剔除，混进提交词表 | 1 | 1 | ✅ |
| M4 | 停用模板间一致性比对 | 2 | 2 | ✅ |
| M5 | 模板间比对改成单向（只查缺项） | 1 | 1 | ✅ |
| M6 | 分类器在「议题已有任何标签」时整体短路 | 2 | 2 | ✅ |
| M7 | 勾选「其他」时附带产出 `priority: p2` | 2 | 2 | ✅ |

M2 是本轮**真实存在**的转换风险（补 `scope:desktop` 的同时必须从 `COMMIT_ONLY_SCOPES` 删掉
`desktop`），故它不是假想的退化，而是"忘做会怎样"的直接验证。七组注入的红名单与预测**逐条相等**
（`# fail` 分别为 3/1/1/2/1/2/2），因此相邻用例在每组注入下均保持绿，判据之间有区分度。

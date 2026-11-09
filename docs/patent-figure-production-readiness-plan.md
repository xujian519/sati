# 专利制图生产可用化实施方案（0.5.0 阶段）

> 状态：**规划中（待评审）**。0.5.0 阶段目标：**使专利制图达到生产可用**。
> 制图的生产部件**已齐全**（工具面、核验面、门禁面、渲染面、落版面齐备），本轮**不补件**，
> 只做三件事：**优化代码、精简代码、测试稳定性**。
> 范围：`src/patent/figuregen/`、`src/patent/figure/`、`src/tool/builtin/patentFigure*.ts`、
> `tests/patent/figuregen/`、`tests/patent/figure/`、`.github/workflows/ci.yml`
> 依据：**2026-11-09 对制图域的全量实测**（规模用仓库自带 `scripts/measure-techdebt.mjs` 测量，
> 其余用 grep / 引用图谱实测）——本文所有数字均来自当次实测，非台账推断。
> 前序：`docs/patent-figure-hardening-plan.md`（核验侧加固，已实施）、
> `docs/patent-figure-harness-parity-plan.md`（合规侧对齐，已实施）、
> `docs/research/patent-figure-dsh-delta-2026-10.md`（DSH 差集调研）

---

## 0. 摘要

**制图域已到「部件齐全、接线完整」的阶段**。工具面 5 个工具全部注册并有生产调用方；
核验面 V 结构规则 / PX 像素门禁 / RC 渲染复核 / C 投影几何四族证据同权消费；
门禁面 `figure-gate` 原子挂 HITL，缺 sidecar 时降级且如实说明「附图核验未执行」；
渲染面 SVG / Graphviz（外部 + WASM）/ Inkscape / CAD-FreeCAD 四条通路并存；
落版面有法域档案与落版页。

**因此 0.5.0 不是「再加能力」，而是「让已有能力可被信任地长期运行」。** 实测暴露的三类问题恰好对应
用户提出的三条战线：

| 战线 | 实测发现 | 严重级 |
|---|---|---|
| **A 代码优化** | 制图域**零 god function**（≥300 行函数为 0），但两个大文件仍在 Top 30 榜内：`leader-line.ts` 980 行、`inkscape-renderer.ts` 916 行（后者登记为 PS-22，自 2026-10-12 sweep 起未承接） | P2 |
| **B 代码精简** | 三个外部二进制探测契约各不相同（源码自述「已知漂移」）；两个**已实现但生产不可达**的模块共 412 行挂了 5 周（TD-PATENT-N34）；`escapeXml` 两份且**宽松那份漏转义 `'`**（TD-PATENT-N27 未清的最后残留） | P2 / P3 |
| **C 测试稳定性** | graphviz 真机用例在**注册期**决定 skip，skip 数在 4/6 之间跳（TD-TEST-003，状态 new）；CI 信号守卫**只覆盖 graphviz**，Inkscape / FreeCAD 真机链路在 CI 上是「无信号」；唯一时序敏感测试文件是 `inkscape-renderer.spec.ts` | P2 |

**关键判断**：A 战线（拆大文件）收益最直观但风险最低、增量价值最低——拆完功能一样；B 战线（精简与契约统一）
直接降低「同一件事有两种口径」的隐患；C 战线（测试稳定性）是把「跑过了」变成「确实验过了」，
**对「生产可用」这个目标的贡献权重最高**。因此本方案的批次顺序是 **C → B → A**：
先把信号做实，再清理口径，最后才做结构性拆分。

### 0.1 已定决策（待 2026-11 评审确认）

| # | 决策点 | 结论 | 影响 |
|---|---|---|---|
| D1 | 本轮范围 | **三战线收口，不补新件**：不新增图型、不新增 V 系列规则、不改核验阈值与法域口径 | §2.1 的能力全部冻结为「不动」 |
| D2 | 批次顺序 | **C → B → A**：先做信号与稳定性，再做口径统一，最后做结构性拆分 | §9 批次表 |
| D3 | 拆分粒度 | 按**可独立验证的职责**切，不按行数切；拆出的模块须有独立单测，否则等于把耦合换个文件 | §3 A1/A2 的验收列 |
| D4 | 不可达模块处置 | **接线优先、删除兜底**：先找产品位（PDF→图→分析、网表可视化）；确无产品位再删，删则连带 spec 一起删 | §4 B4 |
| D5 | 外部二进制契约 | 三个探测点统一为 **fail-loud**：`显式覆盖值不存在即抛`，与 `resolveFreecadCmd` / `resolveInkscapeCmd` 对齐；`resolveDotBinary` 从 fail-open 改为 fail-loud | §4 B3；**注意**：改 dot 探测会触及 `render-graphviz.ts` 的公开面，需评估重录 |
| D6 | CI 依赖镜像 | **只装 graphviz + inkscape**（apt 均可装）；FreeCAD（2.6GB）**不装**，其真机链路改由「信号缺失显式化」而非「装上」解决 | §5 C2/C3 |
| D7 | 「跳过即无信号」判据 | 任何依赖外部二进制的用例组，其 skip 必须有一条**对应的守卫用例**在 CI 上断言「依赖确实可用」；否则视为无信号，红 | §5 C2，沿用 `external-dependency-signal.spec.ts` 既有范式 |

### 0.2 本轮明确不做

- **不新增能力**：图型扩展、新规则面、新工具参数一律不做——部件已齐全，扩能力会让「生产可用」更远。
- **不改核验语义**：任何阈值、纸面常数、法域口径、规则编号均不动；本轮改的是**代码形态**不是**判定结果**。
- **不动 llm-replay fixture**：因此**不碰任何工具的 `inputSchema`**（D5 若波及 dot 探测，须先确认请求键是否变化）。
- **不对外工具面做增删**：`patent_figure_generate` / `patent_figure_check` / `patent_figure_project` /
  `analyze_patent_figure` / `search_patent_figure` 五个工具的入参与产出保持不变。
- **不做 1.0.0 的破坏性清理**：`0.x` 阶段按 SemVer 宽容期约定，所有改动保持向后兼容。

---

## 1. 先读：必须遵守的仓库纪律

| # | 纪律 | 本方案的具体含义 |
|---|---|---|
| 1 | **技术债台账是唯一事实源**（`docs/technical-debt/backlog.md`） | 本轮所有修复**必须回填台账条目状态**（TD-PATENT-N27 / N34 / N36 / TD-TEST-003 / PS-22），不得只改代码不回填；新增条目按 §37.x 体例登记 |
| 2 | **一个关注点一个提交** | A/B/C 三条战线各自独立 PR；功能批次里不做结构性重构（本方案本身即为此设的独立批次） |
| 3 | **规模基线由 `scripts/measure-techdebt.mjs` 维护** | 拆分后必须跑 `pnpm --filter edgeclaw-memory-core build && node scripts/measure-techdebt.mjs --update` 刷新 `docs/technical-debt/metrics.md`，并回填 `docs/code-facts.md`（`pnpm gen:doc-claims`） |
| 4 | **架构基线带行数棘轮** | `docs/architecture-baseline.json` 的 file-size 存量豁免**按文件名作 key**（TD-PROCGATE-008 已登记该形态风险）——拆分后豁免条目**必须删掉**而非改小，否则巨型文件可在豁免名义下持续增长 |
| 5 | **决策记录**（`docs/notes/implemented/`） | 每条改变了对外契约的变更须附一条 note，含 `## Alternatives considered`；纯内部重构可合并为一条批次 note |
| 6 | **零 `any`、零裸 `catch`、零 TODO** | 制图域当前实测为 **0 / 0 / 0**（§2.5）——本轮**不得回退**：新写的模块必须同样干净 |
| 7 | **隐藏清单纪律** | 评分线、阈值、跳过条件等数字不得写进 worker 可见面（原子描述、manifest 阶段描述）；只出现在报告与本文档 |
| 8 | **边界** | `src/` 不得导入 `ui/`；patent 域不得依赖 `tool/` 层（`figuregen` 保持纯函数、无 I/O 决策） |
| 9 | **验证顺序** | `pnpm check` → `pnpm test`（`pnpm check` 不含 test）；提交走分支 + PR |
| 10 | **PR 须关联 issue** | CI 有 `Require linked issue for pull requests` 门禁——每个批次开工前须先建 issue（§9 已列） |

---

## 2. 现状盘点（2026-11-09 实测）

### 2.1 部件齐全度 — 本轮冻结为「不动」的部分

| 能力面 | 落点 | 状态 |
|---|---|---|
| 工具面 | `patent_figure_generate` / `patent_figure_check` / `patent_figure_project` / `analyze_patent_figure` / `search_patent_figure`（5 个，全部在 `createBuiltinRegistry` 注册） | 冻结 |
| 复核与契约共享 | `patentFigureReview.ts`（生成期渲染门禁 + RC1–RC7 + 跨调用占用核对）、`patentFigureSchema.ts`（图幅/法域/图号 schema） | 冻结 |
| 核验规则面 | `check-rules.ts` 733 行、`wording-rules.ts` 262 行、`numeral.ts`、`spec-sections.ts`、`glyph-box.ts` | 冻结 |
| 四族证据 | V 结构规则 / PX 像素门禁（`pixel-gate.ts`）/ RC 渲染复核（`render-check*.ts`）/ C 投影几何（`cad/checks.ts`） | 冻结 |
| 门禁 | `figure-gate` 原子（`src/patent/atoms/handlers/builtin/figure.ts`），挂 HITL，缺 sidecar 降级且如实说明「附图核验未执行」 | 冻结 |
| 渲染通路 | SVG（`render-svg.ts`）/ Graphviz 外部（`render-graphviz.ts`）+ WASM（`render-viz-wasm.ts`）/ Inkscape（`inkscape-renderer.ts`）/ CAD-FreeCAD（`cad/`） | 冻结 |
| 落版与法域 | `office-profile.ts`（法域档案）、`submission-page.ts`（落版页）、`page-contract.ts` | 冻结 |
| 安全与用语 | `svg-safety.ts`（外部 SVG 安全门）、`wording-rules.ts`（图面用语 V12–V14） | 冻结 |

### 2.2 规模与结构现状

| 指标 | 数值 | 来源 |
|---|---|---|
| `src/patent/figuregen/` | 44 文件 / 11526 行 | 实测 |
| `src/patent/figure/` | 17 文件 / 2904 行 | 实测 |
| 制图测试 | 51 文件 / 12210 行 | 实测 |
| **god function（≥300 行函数）** | **0** | `measure-techdebt.mjs` |
| Top 30 大文件中的制图文件 | 2 个：`leader-line.ts` 980 行、`inkscape-renderer.ts` 916 行 | `docs/technical-debt/metrics.md` |
| 800 行上限超限 | `inkscape-renderer.ts`（916 行）仍超；`leader-line.ts`（980 行）亦超 | 实测 |
| 制图域 `any` / `TODO`/`FIXME` | **0 / 0** | 实测 |

### 2.3 精简候选（B 战线）

> **重要更正（2026-11-09 二次实测）**：TD-PATENT-N27 原文记「`escapeXml` ×4、`fmt` ×4（精度已漂移出
> 1/2/3 位）、几何谓词 ×2」。**今日实测该条目已实质收敛**（见下表备注）——
> 规划不能照抄台账，必须以当次实测为准。

| # | 候选 | 当次实测 | 载体 |
|---|---|---|---|
| B1 | `fmt` 同名不同精度 | **1 份实现 + 3 处薄包装**：`render-utils.ts:41`（`FMT_DIGITS=1`）、`cad/render-cad.ts:238`（钉 3 位）、`submission-page.ts:131`（钉 2 位）、`chart.ts:126` `fmtTick`（钉 6 位）。**各域精度都是显式钉死的域常量，是正确形态**，残留问题只是「同名不同精度」的可读性 | TD-PATENT-N27（**已实质收敛**，仅剩命名可读性） |
| B2 | `escapeXml` 两份 | `render-utils.ts:53` 转义 `& < > " '`（5 字符）；`netlist-viz.ts:179` 转义 `& < > "`（**4 字符，漏 `'`**）——**宽松的那份在 netlist-viz** | TD-PATENT-N27（残留最后一项） |
| B3 | 外部二进制探测契约 | 三处各异：`resolveFreecadCmd` fail-loud、`resolveInkscapeCmd` fail-loud、`resolveDotBinary` fail-open；`inkscape-renderer.ts:34` **自述「属已知漂移」** | 新登记 |
| B4 | 生产不可达模块 | `pdf-extract.ts` 231 行 + `netlist-viz.ts` 181 行 = **412 行**，全 `src/` grep **0 处外部引用**（仅 barrel 导出命中）；各带 spec ⇒「有测试」掩盖「无调用方」 | TD-PATENT-N34（2026-10-01 复核，状态 new，已挂账 5 周） |
| B5 | 几何谓词 | `boxesOverlap` / `boxWithin` **各 1 份**（曾各 2 份，**已清**） | TD-PATENT-N27（该分项已清） |
| B6 | `escapeXml` 副本的**联动处置** | B4 若删除 `netlist-viz.ts`（B4 倾向方案 (b)），`escapeXml` 自动降为 1 份 ⇒ **B2 由 B4 顺带消灭** | 见 §4.4 |

### 2.4 测试稳定性候选（C 战线）

| # | 候选 | 实测 | 载体 |
|---|---|---|---|
| C1 | graphviz skip 口径漂移 | `resolveDotBinary()` 在**注册期**决定 skip，skip 数在 **4/6 之间跳**（取决于 shell PATH 是否含 brew 前缀） | TD-TEST-003（状态 new） |
| C2 | CI 信号守卫覆盖面 | `external-dependency-signal.spec.ts` **只守 graphviz**；CI 镜像**只装 graphviz**（`ci.yml` 第 79–80 行）；Inkscape / FreeCAD 真机链路在 CI 上**无信号** | 新登记 |
| C3 | FreeCAD 链路信号 | 2.6GB 依赖不装是**有意的**，但当前**没有**「本条链路在 CI 未被验证」的显式声明 | 新登记 |
| C4 | 时序敏感断言 | 制图测试中唯一涉及 `mtime` / `Date.now()` / `setTimeout` 的文件是 `inkscape-renderer.spec.ts` | 新登记 |
| C5 | 已知同类先例 | 2026-11-08 `fix(knowledge)` 修「草稿刷新用例在 Linux 上的毫秒级落点抖动」——**同一失败面（文件系统时序精度）的另一实例** | 已修，可作参照 |

### 2.5 健康面（本轮要守住的，不得回退）

- **零 god function**：制图域已把 `check.ts`（曾 754 行 / `checkFigures` 503 行）与 `render-check.ts`
  （曾 1634 行）拆到「无 ≥300 行函数」，是全仓少数达标模块——**本轮拆分不得把它拆回去**。
- **零 `any`、零 TODO/FIXME**：与 `src/agent/loop/` 同档纪律。
- **barrel 零消费已清零**：2026-10-12 sweep 把 `figuregen` barrel 的 84 个零消费导出裁出，
  现为 154/154 全消费（TD-EXTENSION-N08 已回填）——本轮**不得**为「看起来整齐」重新引入。
- **裸 catch 有意图注释**：`catchEmpty` / `catchNoParam.undocumented` 棘轮为 0/0。
- **共享存储已收敛**：`chemistry/index-store.ts` 与 `figure/index-store.ts` 的同构复制已由
  `src/patent/shared/index-store.ts` 收敛（TD-PATENT-N23，#391）。

---

## 3. 战线 A — 代码优化（结构性拆分）

### 3.1 A1：拆分 `inkscape-renderer.ts`（916 行）

| 项 | 内容 |
|---|---|
| 现状 | 单文件承担：可执行发现（`resolveInkscapeCmd`）、运行事实分类（`classifyInkscapeRun`）、SVG 转路径执行、错误面映射 |
| 已有豁免 | `docs/architecture-baseline.json` 的 file-size 存量豁免（带行数棘轮） |
| 拆分依据（可独立验证的职责） | ① 探测层：`resolveInkscapeCmd` + 候选路径表 + fail-loud 契约；② 事实分类层：`classifyInkscapeRun`（纯函数，输入 `InkscapeRunFacts` → 结论）；③ 执行层：进程调用与产物落盘；④ 错误面映射层 |
| 契约影响 | **无对外契约变化**（导出名与类型名逐字不变，barrel 不变） |
| 新增/改测试 | 每层独立单测；探测层补「显式覆盖值不存在即抛」的负控制（现仅有一处断言） |
| 前置 | A1 完成后**删除**该文件的 file-size 豁免条目（纪律 4） |
| 关联 | TD-PATENT-N36、PS-22 |

### 3.2 A2：拆分 `leader-line.ts`（980 行）

| 项 | 内容 |
|---|---|
| 现状 | 引线择位：相位方向 × 环距候选生成 → 硬拒绝 → 评分 → 有界回溯（≤3 轮）；CAD strict 模式抛 `LeaderPlacementError` |
| 最近变更 | 2026-11-08 `feat(patent)` 改为评分加有界回溯（#844），并登记了行数豁免 |
| 拆分依据 | ① 候选生成（相位 × 环距）；② 几何谓词（射线-字框首个进入点）；③ 评分（长度 / 方向偏离 / 擦边 / 拥挤）；④ 有界回溯调度；⑤ CAD strict 抛错面 |
| 契约影响 | **无对外契约变化**（`LeaderPlacementError` 的类名、构造签名、错误信息格式不变） |
| 新增/改测试 | 评分与硬拒绝的边界用例补齐（现由 `leader-line.spec.ts` 599 行覆盖，需在拆分后按层归位） |
| 关联 | TD-PATENT-N36（同一条目下的另一文件） |

### 3.3 A3：`check-rules.ts`（733 行）的规则表数据化评估

**本轮只做评估，不做改造。** 该文件是 21 条规则 × 3 法域 × 10 选项的规则表，历史上
`check.ts` 的 503 行 god function 正是从这里长出来的（TD-PATENT-N26，已处置）。当前已是
「规则函数 + 表」形态，**零 god function**。是否进一步数据化（纯表 + 解释器）需先回答：
规则是否都可用数据表达？若多数规则含条件逻辑，数据化只会把复杂度从代码搬到数据里而**不降低复杂度**。
**结论倾向：不做。** 若评估发现规则表存在真实重复（如同一法域分支在多条规则里复制），则**只去重**，
不改表达形态（见 §4 B6）。

---

## 4. 战线 B — 代码精简

### 4.1 B1：`fmt` 同名不同精度的可读性收敛（低优先级）

**先纠正台账**：TD-PATENT-N27 记「`fmt` ×4（精度已漂移出 1/2/3 位）」。2026-11-09 实测的真实结构是
**1 份实现 + 3 处薄包装**，且每处的精度都是**显式钉死的域常量**：

| 位置 | 形态 | 精度 |
|---|---|---|
| `src/patent/figuregen/render-utils.ts:41` | 唯一实现 `fmt(value, digits = FMT_DIGITS)` | 默认 `FMT_DIGITS = 1` |
| `src/patent/figuregen/cad/render-cad.ts:238` | `const fmt = (value) => fmtShared(value, CAD_COORD_DIGITS)` | 3 位 |
| `src/patent/figuregen/submission-page.ts:131` | `const fmt = (value) => fmtShared(value, SUBMISSION_COORD_DIGITS)` | 2 位 |
| `src/patent/figuregen/chart.ts:126` | `fmtTick(value) => fmt(value, TICK_DIGITS)` | 6 位 |

**这不是重复实现，是各域显式声明精度契约的正确形态**——「精度漂移」在今天读起来是「三处各自钉死」，
反而比一个全局默认精度更可控。**因此本条不合并实现、不统一精度**（统一精度会改动 CAD 坐标与落版页的
渲染输出，属于改行为，不属精简）。

**实际可做的只剩一件事**：**消除「同名不同精度」的阅读陷阱**。
`render-cad.ts` 与 `submission-page.ts` 各自定义一个叫 `fmt` 的局部绑定，读者无法从调用点看出它用的是 3 位还是 2 位。

| 项 | 内容 |
|---|---|
| 方案 | 两处局部绑定改为**具名**（如 `fmtCadCoord` / `fmtSubmissionCoord`），或直接去掉局部绑定、在调用点显式传 `CAD_COORD_DIGITS` / `SUBMISSION_COORD_DIGITS` |
| 契约影响 | **无**：渲染输出逐字节不变（精度与调用点均不变） |
| 验收 | 收敛后制图域**同名 `fmt` 的局部绑定数 = 0**；`render-utils.ts` 的 `fmt` 仍是唯一实现 |
| 关联 | TD-PATENT-N27（**须回填：该条已实质收敛**，本条为残留项） |

> **本条的优先级**：P3。它不降低任何风险，只是让三处精度契约在阅读时更清楚。
> 若本轮周期紧张，**可整条顺延**——但 TD-PATENT-N27 的台账状态仍须回填为「已收敛」。

### 4.2 B2：`escapeXml` 两份收敛（**有安全面，优先级高于 B1**）

当次实测的**两份并不等价**：

| 位置 | 转义字符集 | 判定 |
|---|---|---|
| `src/patent/figuregen/render-utils.ts:53` | `& < > " '`（5 个，`'` → `&apos;`） | **更严**，是全仓的共享实现 |
| `src/patent/figure/netlist-viz.ts:179` | `& < > "`（**4 个，漏 `'`**） | **更宽松** |

⇒ 收敛时**保留 `render-utils.ts` 那份**（含 `'`），把 `netlist-viz.ts` 的局部实现改为从
`figuregen/render-utils.js` 导入。**绝不以「合并」为名取宽松的那份**——那会放宽转义面。

**与 B4 的联动**：`netlist-viz.ts` 正是 B4 的删除对象之一（§4.4）⇒ **B4 方案 (b) 执行后，
`escapeXml` 自动降为 1 份，B2 无需单独改动代码，只需回填台账**。这是本轮唯一的「一笔债顺带还清两笔」
的联动，故 B2 的**执行顺序排在 B4 之后**。

| 项 | 内容 |
|---|---|
| 方案（若 B4 走 (a) 保留 netlist-viz） | `netlist-viz.ts` 的局部 `escapeXml` 改为导入 `figuregen/render-utils.js` 的共享实现 |
| 契约影响 | 转义面**收紧**（`'` 开始被转义）——netlist-viz 的 SVG 输出会变，但**变的是更正确的方向** |
| 验收 | 制图域 `escapeXml` 独立实现数 = 1，且该实现的字符集为 5 字符全集 |
| 关联 | TD-PATENT-N27 |

### 4.3 B3：三个外部二进制探测契约统一（fail-loud）

| 探测点 | 现状 | 目标 |
|---|---|---|
| `resolveFreecadCmd` | 显式覆盖值不存在即抛（fail-loud） | 保持 |
| `resolveInkscapeCmd` | 显式覆盖值不存在即抛（fail-loud） | 保持 |
| `resolveDotBinary` | **fail-open**（找不到即返回 null，调用方降级） | 改为 fail-loud：`SATI_GRAPHVIZ_DOT` 显式指向不存在的路径时抛；**未显式配置且 PATH 找不到时仍返回 null**（此时是「没装」而非「配错了」） |

关键区分：**「显式配置了但路径不对」= 配置错误 = fail-loud；「压根没装」= 环境状态 = 降级**。
这条区分同时解决 §5 C1 的一半问题：显式配置路径写错时不再静默变成 skip。

**契约影响评估**：`render-graphviz.ts` 的 `resolveDotBinary` 是导出的公开面。
若改动其返回语义，需确认 llm-replay 请求键是否受影响——**该函数不参与工具 `inputSchema`**，
请求键只取工具的 `{ name, inputSchema }`，故**不触发重录**（除非同批改了工具 schema，本方案不改）。

### 4.4 B4：生产不可达模块处置（412 行）

两个模块各有 spec，但**全 `src/` 无生产调用方**：

| 模块 | 行数 | 能力 | 处置选项 |
|---|---|---|---|
| `src/patent/figure/pdf-extract.ts` | 231 | mupdf 页面转图 + 候选附图页启发式打分 | (a) 接到 `analyze_patent_figure` 的 PDF 输入；(b) 删除 |
| `src/patent/figure/netlist-viz.ts` | 181 | 网表可视化（Mermaid / SVG / 摘要） | (a) 确定消费方；(b) 删除 |

**本轮倾向 (b) 删除**，理由：
- (a) 路径要扩 `analyze_patent_figure` 的入参描述 ⇒ **触发 llm-replay 重录**（批次 B 成本），
  而本轮明确不动 fixture（纪律 3、D5）；
- 网表可视化**当前无产品位**——专利附图的电气图（`analyze-electrical.ts` 已有 1 处调用）走的是
  另一条路，网表可视化不在任何工具输出里；
- **412 行带测试却不产生任何生产行为**，是「测试绿 ≠ 产品可用」的教科书样本。

若评审认为 (a) 更值得（PDF → 图 → 分析确有产品价值），则本条移出本轮、顺延到 1.0.0，
且**须同批重录 fixture**。**二选一，不做「先删后想」。**

### 4.5 B5：几何谓词确认（**已清，本轮只回填台账**）

当次实测：`boxesOverlap` / `boxWithin` **各 1 份**，均在 `src/patent/figuregen/render-utils.ts`
（`render-utils.ts:75` / `:85`）——TD-PATENT-N27 原文的「各 2 份，且同容差但一份常量一份字面量」
**已不再成立**。

本轮**只需核实容差常量是否同源**（两处是否引用同一个容差常量而非各自字面量），
确认后**回填台账状态**即可，无代码改动。

### 4.6 B7：`check-rules.ts` 规则表内的真实重复（仅在 A3 评估发现后执行）

若 A3 评估发现同一法域分支在多条规则里复制，则**只把重复分支提取为共享判定**，
不改规则表的表达形态、不动规则编号、不动阈值。

---

## 5. 战线 C — 测试稳定性

### 5.1 C1：graphviz skip 口径漂移（TD-TEST-003）

**根因**：`resolveDotBinary()`（PATH 扫描）在**测试注册期**求值，skip 数随 shell PATH 是否含
brew 前缀在 **4/6 之间跳**——同一份 `dist` 在不同 shell 下「跑过的用例数」不同。

**方案**：
1. 按 §4 B3 把「显式配置路径不对」从 fail-open 改为 fail-loud——配置错误不再伪装成「没装」；
2. `resolveDotBinary()` 兜底探测常见 brew 前缀（`/opt/homebrew/bin`、`/usr/local/bin`），
   或优先读 `SATI_GRAPHVIZ_DOT`；
3. **跳过数必须稳定**：同一环境下「因缺 graphviz 跳过」与「真跑」两组用例数**可预测且有文档**，
   禁止再出现 4/6 这种随 shell 漂移的读数。

**验收**：在 `PATH` 不含 brew 前缀的 shell 下跑本仓库，skip 数与 CI 下（装了 graphviz）**完全一致**。

### 5.2 C2：CI 信号守卫扩到 Inkscape（新增）

沿用 `tests/patent/figuregen/external-dependency-signal.spec.ts` 的既有范式：
CI 上断言 `resolveInkscapeCmd()` 确实找得到可执行文件；找不到就红，并提示
「把 inkscape 装进 CI 镜像，而不是接受这个静默」。

**前置**：CI 镜像需安装 inkscape（`ci.yml` 第 79–80 行只装了 graphviz）。
**风险**：inkscape 是 GUI 应用，headless 调用需 `--export-type` 且依赖 cairo/pango 字体栈——
**必须先在本地验证 headless 可用**再进 CI 镜像，否则会引入新的「装得上但跑不通」的跳过面。

### 5.3 C3：FreeCAD 链路的「未验证」显式化（新增）

2.6GB 依赖**有意不装**（D6）。但当前状态是「CI 上这条链路既没跑也没声明没跑」——
**沉默不等于通过**。

**方案**：加一条 CI 守卫，断言 **FreeCAD 链路在 CI 上处于「已知未验证」状态**，
其措辞与产物必须与 graphviz / inkscape 的「已验证」形成**显式对照**，
使任何人读 CI 日志时能立刻看出「哪几条链路真的被验证过、哪几条没有」。

这不是给 CI 加负担，而是把**覆盖率缺口显式化**——与「跳过即无信号」（D7）同源。

### 5.4 C4：时序敏感断言加固（新增）

`inkscape-renderer.spec.ts` 是制图测试中唯一涉及 `mtime` / `Date.now()` / `setTimeout` 的文件。
参照 2026-11-08 知识域「毫秒级落点抖动」的修法（同 §2.5 C5），逐个审：
- 断言是否依赖**整毫秒边界**（应改为落在目标毫秒内部，亚毫秒偏移）；
- 断言是否依赖**跨平台 timeval 截断**（Linux/libuv → `utimes(2)` 最多偏低 1µs）；
- 临时目录名是否会被正则误命中（`fix(patent) #845` 同类问题的制图版）。

### 5.5 C5：基准与 fixture 的重录纪律（**触发条件已变化**）

原触发条件是「B1 统一 `fmt` 精度 ⇒ 渲染输出变化 ⇒ 需重录」。**实测后此前提不成立**：
B1 收敛后渲染输出**逐字节不变**（精度与调用点均不变），**不触发重录**。

当次实测后，**唯一可能改变渲染输出的是 B2**（`escapeXml` 收紧，`'` 开始被转义）——
而 B2 仅在 B4 走方案 (a)（保留 `netlist-viz`）时才需要动手。因此：

- **B4 走 (b) 删除** ⇒ 本轮**零重录**；
- **B4 走 (a) 接线** ⇒ B2 的转义收紧影响 `netlist-viz` 的 SVG 输出 ⇒ 须重录该链路的渲染基准，
  且按纪律「**一次完成、合并到同一 PR**」（沿用 `patent-figure-hardening-plan.md` §7 的「一次重录」经验），
  不拆成多次重录的 PR 链。

无论走哪条路：**本方案本身不触碰任何工具的 `inputSchema`**，故 llm-replay 请求键不变、
**不触发 fixture 重录**（`requestKey.ts` 的 tools 投影只取 `{ name, inputSchema }`）。

---

## 6. 变更地图

| 编号 | 变更 | 落点 | 契约影响 | 新增/改测试 | 前置 | 关联条目 |
|---|---|---|---|---|---|---|
| C1 | dot 探测兜底 + 显式配置 fail-loud + skip 数稳定 | `src/patent/figuregen/render-graphviz.ts` | `resolveDotBinary` 返回语义（显式配置不存在时由 null 改抛） | 负控制用例 + skip 数断言 | — | TD-TEST-003 |
| C2 | inkscape CI 信号守卫 | `tests/patent/figuregen/external-dependency-signal.spec.ts`、`.github/workflows/ci.yml` | 无 | 新增 | inkscape headless 本地验证通过 | 新登记 |
| C3 | FreeCAD「未验证」显式化 | 同上 | 无 | 新增 | — | 新登记 |
| C4 | 时序敏感断言加固 | `tests/patent/figuregen/inkscape-renderer.spec.ts` | 无 | 改 | — | 新登记 |
| B1 | `fmt` 同名不同精度的可读性收敛（**不合并实现**） | `cad/render-cad.ts:238`、`submission-page.ts:131` | 无；渲染输出**逐字节不变** | 无需新用例 | — | TD-PATENT-N27（已收敛，回填） |
| B2 | `escapeXml` 收敛为更严的一份（保留 5 字符集） | `src/patent/figure/netlist-viz.ts:179` | 转义面**收紧**（`'` 开始转义） | 转义字符集断言 | **排在 B4 之后** | TD-PATENT-N27 |
| B3 | 三个二进制探测契约统一 | `render-graphviz.ts` / `inkscape-renderer.ts` / `cad/freecad.ts` | `resolveDotBinary` 语义（同 C1） | 负控制 | — | 新登记 |
| B4 | 不可达模块处置（二选一） | `src/patent/figure/pdf-extract.ts`、`netlist-viz.ts` | 若删则相应 barrel 导出移除 | **连带删除对应 spec** | 评审定夺 (a)/(b) | TD-PATENT-N34 |
| B5 | 几何谓词容差确认（**已清**） | `figuregen/render-utils.ts:75/85` | 无 | 若容差不同源则补断言 | — | TD-PATENT-N27（回填） |
| B7 | `check-rules.ts` 规则表内的真实重复（**条件执行**） | `src/patent/figuregen/check-rules.ts` | 无 | 视重复面而定 | A3 评估结论 | — |
| A1 | 拆 `inkscape-renderer.ts`（916） | `src/patent/figuregen/inkscape*/` | 导出名逐字不变 | 每层独立单测 | C/B 批次完成 | TD-PATENT-N36 / PS-22 |
| A2 | 拆 `leader-line.ts`（980） | `src/patent/figuregen/leader*/` | `LeaderPlacementError` 签名不变 | 每层独立单测 | C/B 批次完成 | TD-PATENT-N36 |
| A3 | 规则表数据化**评估**（倾向不做） | `src/patent/figuregen/check-rules.ts` | 无 | 无 | — | — |

**共同约束**：A1/A2 完成后**删除** `docs/architecture-baseline.json` 中对应的 file-size 豁免条目
（纪律 4），并刷新 `docs/technical-debt/metrics.md`（`measure-techdebt.mjs --update`）
与 `docs/code-facts.md`（`pnpm gen:doc-claims`）。

---

## 7. 验收主线

**总体验收**：一份实用新型案在**干净 CI 镜像**上跑完 `patent_drafting_v1`，
附图阶段产出 `figure-check.json` 留痕，V2/V4 级问题阻断或挂 HITL；
A4 打印稿中每幅图的物理尺寸与字高落在设定区间内；
**且 CI 日志能一眼看出哪些渲染通路被真正验证过、哪些没有**（C2/C3 的直接产出）。

**分线验收**：

| 战线 | 验收判据 | 判据来源 |
|---|---|---|
| A | 制图域 god function 仍为 **0**；Top 30 大文件榜中制图文件 **2 → 0**；豁免条目清零 | `measure-techdebt.mjs` |
| B | 制图域**同名 `fmt` 的局部绑定数 = 0**（实现仍唯一，`render-utils.ts`）；`escapeXml` 独立实现数 2 → **1** 且字符集为 5 字符全集；二进制探测契约 **3 → 1 种语义**；生产不可达模块 **412 行 → 0**（或接线后有真实调用方）；`TD-PATENT-N27` 台账状态回填为已收敛 | grep + 引用图谱实测 |
| C | 同一 `dist` 在不同 shell 下 skip 数**完全一致**；CI 上 graphviz + inkscape 两条链路**有守卫断言**；FreeCAD「未验证」**显式声明** | CI 日志 + 用例数 |

**红灯判据**：任一条不满足即红，不得以「本轮范围外」放行。

---

## 8. 风险与不做的事

| 风险 | 表现 | 处置 |
|---|---|---|
| **拆分引入回归** | A1/A2 拆开引线择位与 Inkscape 执行，行为漂移 | 每层独立单测；拆分 PR 必须「只搬不改」——搬完后**行为差异必须为 0**，否则就是 bug |
| **基准重录拖尾** | `fmt` 精度统一 ⇒ 画面对比图重录，重录易失败 | 一次完成、合并同 PR（§5 C5） |
| **inkscape 进 CI 拉长镜像 / 引入新跳过面** | GUI 应用的 headless 依赖 cairo/pango | **先本地验证 headless**再进镜像；装不上则**不改 CI**，改为在本机显式声明未验证（C3 范式） |
| **删掉不可达模块后有人要用** | B4 删除 `pdf-extract` / `netlist-viz` | git 历史可回溯；且两模块**当前 0 生产调用方**，删除不改变任何现有行为 |
| **本轮变成「大重构」而拖住 0.5.0** | A 战线拆分耗时超预期 | D2 已定 **C → B → A**：A 战线可整体顺延到 0.5.1，不影响 C/B 交付 |
| **口径统一改了「判定结果」** | B1 精度变化让某些图从 fail 变 pass | **数值精度不是判定阈值**：V 规则的阈值与常量一律不动（§0.2） |

---

## 9. 批次与验收（0.5.0 内）

> 每个批次开工前**须先建 issue**（CI 有 PR 关联 issue 门禁）。
> 批次内**不混入其他战线的改动**（纪律 2）。

| 批次 | 内容 | 战场 | 产出 | 门禁 |
|---|---|---|---|---|
| **R0** | issue 批量建立 + 本文档评审定稿（D1–D7） | — | issue ×7（每批次一个） | 评审记录 |
| **R1** | C1 + B3：dot 探测契约统一与 skip 数稳定 | C/B | 显式配置 fail-loud、skip 数确定 | `pnpm test` + 不同 shell 下 skip 数一致 |
| **R2** | C2 + C3：CI 信号守卫扩到 inkscape、FreeCAD 未验证显式化 | C | CI 镜像 + 两条守卫用例 | CI 绿灯且日志可读出验证矩阵 |
| **R3** | C4：时序敏感断言加固 | C | 断言不再依赖整毫秒边界 | 连续 10 次跑不抖 |
| **R4** | B1：`fmt` 同名不同精度的可读性收敛（**不合并实现、不改精度**，渲染输出逐字节不变） | B | 同名局部绑定数 = 0 | 渲染输出**逐字节比对无差异** + TD-PATENT-N27 回填 |
| **R5** | B4：不可达模块处置（二选一） | B | 412 行清零 | 台账回填 + spec 连带处置 |
| **R6** | B2（**仅当 R5 走 (a) 才执行**）：`escapeXml` 收敛为更严的一份 | B | 转义面收紧 + 必要时重录一次 | 转义字符集断言 + 基准重录 |
| **R7** | A1 + A2：拆两个大文件 + 豁免清零 | A | Top 30 榜制图文件归零 | 行为差异为 0 + 豁免删除 + metrics 刷新 |

**批次顺序理由**（D2）：R1–R3（信号）必须先于 R4–R7（改动）——
**在信号不可信之前做重构，等于在盲改**。
另注：**R6 排在 R5 之后**是因为 `netlist-viz` 若被删除，`escapeXml` 副本自动消失（§4.2），
先删再定可避免做两次改动。

---

## 10. 后续轮次（0.5.0 之外）

| 轮次 | 内容 | 条件 |
|---|---|---|
| 0.5.1+ | A3 规则表数据化（若评估结论翻转） | A3 评估结论 |
| 1.0.0 前 | 「PDF → 图 → 分析」接线（`pdf-extract` 接 `analyze_patent_figure`） | 需触发 llm-replay 重录，须单独批次 |
| 1.0.0 前 | 电气图 / 网表可视化的产品位定义 | 需产品决策，非工程决策 |
| 1.0.0 | 按 SemVer 破坏性清理（本方案刻意保持的兼容包袱） | 0.x 宽容期结束 |

---

## 附录 A：本文数字的测量方式（可复算）

```bash
# 规模与 god function（仓库自带测量，基线见 docs/technical-debt/metrics.md）
node scripts/measure-techdebt.mjs

# 领域规模
find src/patent/figuregen -name '*.ts' | wc -l          # 44
find src/patent/figuregen -name '*.ts' -exec cat {} + | wc -l   # 11526
find src/patent/figure    -name '*.ts' -exec cat {} + | wc -l   # 2904
find tests -path '*figure*' -name '*.ts' | wc -l          # 51

# 精简候选（按词边界统计「函数名精确匹配」的定义数——注意不用
# grep "function fmt" 这类前缀匹配，会把 fmtTick 一并算进去）
grep -rnE "(function|const|let)[[:space:]]+fmt[[:space:]]*(=|\()" \
  src/patent/figuregen src/patent/figure src/tool/builtin/patentFigure*.ts   # 3（1 实现 + 2 薄包装）
# 注：chart.ts 的 fmtTick 是**不同名**的函数（刻度专用，钉 6 位），不被此式计入——见 §4.1
grep -rnE "(function|const|let)[[:space:]]+escapeXml[[:space:]]*(=|\()" \
  src/patent/figuregen src/patent/figure | wc -l                                # 2（字符集不同，见 §4.2）
grep -rnE "(function|const|let)[[:space:]]+(boxesOverlap|boxWithin)[[:space:]]*(=|\()" \
  src/patent/figuregen src/patent/figure | wc -l                                # 2（各 1 份，已清）

# 不可达模块（外部引用数，应为 0）
grep -rn "pdf-extract\|netlist-viz" src/ --include='*.ts' \
  | grep -v "^src/patent/figure/pdf-extract.ts\|^src/patent/figure/netlist-viz.ts" \
  | grep -v "src/patent/figure/index.ts" | wc -l           # 0

# CI 镜像装了什么
grep -n "apt-get install" .github/workflows/ci.yml          # 仅 graphviz
```

> 测量命令的输出**会随代码演进变化**。本文数字为 **2026-11-09** 的快照；
> 执行批次时以当次实测为准，并同步刷新 `docs/technical-debt/metrics.md` 与 `docs/code-facts.md`。

# 专利附图对齐 deepseek-harness 实施方案（合规侧优先）

> 状态：**已实施**（2026-09-22）。四个提交组全部落地：`feat(patent): 附图外部 SVG 安全门与图面用语规则 V12–V14`（PR-A）、
> `… 附图法域档案 + 落版页 + 图号条件化 + 逐法域字高`（PR-C）、`… 制图工具入参增 pct/图幅/页码/落版（含 fixture 重录）`（PR-D）、
> `… Graphviz WASM 渲染后端`（PR-B）。决策记录见 `docs/notes/implemented/2026-09-22-figure-*.md`（8 条）。
> 实施中的**偏离与新增**见文末「§9 实施结果与偏离」——评审请重点看该节。
> 范围：`src/patent/figuregen/`、`src/tool/builtin/patentFigure*.ts`、`skills/patent-illustrator/`、
> `assets/prompts/patent/cap01-orchestrator.md`、根 `package.json`（新增一个依赖）
> 依据：对 `deepseek-harness/packages/patent/patent-tools/src/figure/`（约 6.6k 行）与
> `tool/`（约 3.6k 行）的源码逐文件阅读，与 Sati `src/patent/figuregen/`（约 3.6k 行）逐项比对。
> 上一轮加固（`docs/patent-figure-hardening-plan.md`，P0–P2 全部已落地）是**核验侧**的加固；
> 本轮是**合规侧**的对齐，两者不重叠。

---

## 0. 摘要

Sati 的附图链在「核验闭环」上领先（确定性规则 V1–V11 + 像素门 + sidecar 漂移检测 + `figure-gate`
工作流门禁 + 审计留痕），deepseek-harness 在「提交合规」与「出图能力」上领先。本轮取前者中
**可一次性补齐、且直接决定「提交会不会被补正」** 的部分，不碰图型扩展。

四类问题按来源分组：

1. **法域合规**：Sati 的 `Jurisdiction` 只有 `cn | us`，纸面常数是单一套 A4 边距且自陈为
   「实践惯例」；字高下限是**跨法域单一 2.0mm**，而 PCT 细则 11.13(h) 与 37 CFR 1.84(p)(3)
   都要求 ≥0.32cm（3.2mm）⇒ 一份 2.5mm 字高的图在 Sati 会「通过」，送 PCT/US 却是缺陷。
2. **图号条件化**：`render-svg.ts:136` 与 `dot.ts` 对**每一幅**图硬写 `图N` / `FIG. N`，
   全库没有 `figure_count` 概念。中国指南一部一章 4.3 把编号系于「两幅以上」；US 侧
   37 CFR 1.84(u)(1) 更硬——**仅一个视图时不得编号、不得出现 "FIG."**。当前 Sati 给单视图
   美国申请图打 `FIG. 1`，正是被禁止的形态。
3. **无落版步骤**：Sati 出的是「图形自身画布」的 SVG，图号画在**图形内部**底部的 caption 带里；
   没有把图形落版到固定 A4 幅面（图号在图形正下方、页码在版心底部）的步骤。
4. **两层入口缺护栏**：吃外部 SVG 的入口（`patent_figure_check` 的 `svg_paths`、`figure-gate`
   的漂移检测）无大小上限、不拒 DOCTYPE/ENTITY/CDATA；图面用语只查「label 过长」，
   缺「尺寸/比例标注、正文引用、图号入图、非中文词语、数字与括号连用」这几类补正通知书的常见缺陷。

另外两处工程收益：把 graphviz 通路从「必须 `brew install graphviz`」改为**打包 WASM 引擎**
（deepseek-harness 做法）；修 `cn-drawing-rules.md` 的规则表漂移。

### 0.1 已定决策（2026-09-22 评审）

| # | 决策点 | 结论 | 影响 |
|---|---|---|---|
| E1 | 本轮范围 | **合规侧优先**（不含图型扩展、引线标号、多面板） | §8 列出下一轮路线 |
| E2 | 是否改 `inputSchema` | **接受一次重录**，本轮所有 schema 变更合并为**一个 PR 一次重录** | §1.1、§5.9 |
| E3 | WASM Graphviz 依赖 | **新增 `@viz-js/viz`**（惰性加载）；先做桌面端打包 spike | §4.3 |
| E4 | `fit_to_page` 默认值 | **默认 `false`**（落版页为**新增附加产物**，不改既有 SVG 契约）。与 deepseek-harness 的默认 `true` 有意不同 | §5.2、附录 B |
| E5 | 是否引入 `semantic` 彩色模式 | **不引入**（构造期黑白不变式保持不变） | §8 |
| E6 | 色彩合规核算模块 | **不单独建 `compliance.ts` 双轨**，规则统一落 `check.ts`；核算纯函数供 check 与工具共用 | §5.3、附录 B |

---

## 1. 纪律与前置约束（本方案各自的含义）

### 1.1 llm-replay 请求键的**精确**组成（已核实源码）

`src/agent/loop/requestInvariant.ts:75`：

```ts
toolSchemaDigest: digestForReplay(
  request.tools?.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })) ?? null,
)
```

`digestForReplay` = sha256(JSON.stringify(…))。由此得出三条**必须**遵守的推论：

| 改动 | 是否变更请求键 | 本方案含义 |
|---|---|---|
| 改工具**顶层** `description` | **否**（不在 digest 输入内） | `patentFigure*.ts` 的顶层 description 可自由更新（含 W0 的用语规则说明），不触发重录 |
| 改 `inputSchema` 内**任一**字段或字段的 `description` 文本 | **是** | W1 的全部入参变更必须集中在**一个 PR**；该 PR 内不得再夹带第二个 schema 变更 |
| 新增/删除**任意**工具 | **是**（digest 覆盖整个工具列表） | 本方案**不新增任何工具**（避免额外变更面，也避免 `default_tool_count`/`patent_tool_count` 漂移） |

**排期硬约束**：重录 PR 必须在 main 上 `llm-replay-real.spec` 为绿时进行。若开工前 main 因
他人改动而红，先修再录，否则录出的记录会立即失配。

### 1.2 仓库门禁清单与本方案的触发关系（已逐条核实）

| 门禁 | 本方案是否触发 | 说明 |
|---|---|---|
| `pnpm check`（聚合） | 触发 | 收尾必跑 |
| `pnpm test` | 触发 | `pnpm check` 不含 test |
| `pnpm measure:update` | **触发（易漏）** | `docs/technical-debt/metrics.md` 的文件数按 `git ls-files --cached --others --exclude-standard` 统计（`scripts/measure-techdebt.mjs:133,147`）⇒ **新增任何 `.ts` 都会改基线**，`check:techdebt-metrics` 会红。顺序：写完文件 → `pnpm measure:update` → 一起提交 |
| `pnpm gen:doc-claims` | 预计**不触发**（仍跑一次确认幂等） | 计数矩阵无「图模块文件数」项；不新增工具则 `default_tool_count`/`patent_tool_count` 不变，不新增顶层模块则 `src_module_count` 不变 |
| `pnpm gen:patent-workflow-docs` | **不触发**（本方案不改 `manifests.ts`，不给 `figure-gate` 加 retry） | 若评审要求加 retry 则触发 |
| `pnpm gen:event-matrix` | **不触发** | 不动 `AgentEvent`/gateway frames |
| `pnpm check:patent-sop` | 触发（文档项） | `cap01-orchestrator.md` 的 `code` 标识符必须真实存在；本方案新增的 3 行工具表引用已注册工具，安全 |
| `pnpm check:skills` | 触发（文档项） | 改 `SKILL.md` 需过 `scripts/validate-skills.mjs`（禁版本营销话术、`type: role` frontmatter 一致性） |
| `pnpm record:replay` | 触发（§5.9） | 重录后必须校验 fixture 结构与可驱动性 |

### 1.3 隐藏清单纪律（沿用）

评分线/阈值**不得**写进 `Atom.description` 与 manifest 阶段描述（worker 可见面）。
本方案新增的阈值（字高下限 3.2mm、页码写法、V12–V17 的阈值常量）只出现在：
`check.ts` 的系数、HITL 报告、`references/*.md`、本文件。`figure-gate` 的 description 保持
「只审什么」的写法（现状即如此，不改）。

### 1.4 法条核验纪律（本方案的最高优先级约束）

项目既有纪律是「**未核验即不写成规则**」（`docs/patent-figure-hardening-plan.md` §10 明确写过）。
本轮要新增法域数值，这条纪律成为**先决条件**，且有一个已实测的坏消息：

> 本地法条库**不覆盖域外法**。实测 `curl "http://127.0.0.1:8100/search?q=37 CFR 1.84 附图"`
> 只返回《中华人民共和国专利法实施细则》；检索「附图 页边距 毫米 图纸」返回的是
> 《地图管理条例》《科学技术档案工作条例》等无关条目。`:8001`（图谱）当前返回 503。
> 即：**CN 侧的附图用纸/页边距条款与 PCT/US 全部条文都必须走外网官方文本**。

因此 §2 的 Gate 0 是本方案的第一道门，未过则该法域不进档案。

### 1.5 决策记录（notes）分配

| PR | note（`docs/notes/implemented/`） | 必须回答的备选 |
|---|---|---|
| W0-1 | `{落地日}-figure-svg-safety-gate` | 为何不把安全门放进 `parseFigureSvg` 内部（见 §4.1） |
| W0-2 | `{落地日}-figure-wording-rules` | 为何 V12–V14 三条而非 DSH 的一条；为何「非中文词语」只在 cn 判、「括号连用」只在 pct/us 判 |
| W0-3 | `{落地日}-figure-graphviz-wasm` | 为何不改默认渲染器；桌面 spike 结论 |
| W1-1 | `{落地日}-figure-office-profiles` | 为何只列已核验法域、为何不列 EPO；为何 `jurisdiction` 不改名为 `target_office` |
| W1-2 | `{落地日}-figure-submission-page` | 为何默认 `fit_to_page: false`（与 DSH 不同） |
| W1-3 | `{落地日}-figure-conditional-caption` | 为何图号是条件化而非「总是编号」；画幅变更的代价 |
| W1-4 | `{落地日}-figure-per-jurisdiction-font-minimum` | 为何 CN 保留 2.0mm 实践下限而不改判「无下限」 |
| W1-5 | `{落地日}-figure-pct-jurisdiction` | 为何把 pct 放进 `jurisdiction` 而不是新字段；V10/V11 在 pct 下的处置 |

> 本轮是提案阶段，`docs/notes/proposed/` 暂不新建（提案以本文档为唯一载体，落地后逐 PR
> 迁为 `implemented/`）。

---

## 2. Gate 0：法条核验前置任务（必须先做，产出物入库）

**目的**：把 §5.1 的 `office-profile.ts` 变成一张「逐条注明出处」的常数表，而不是一组猜测值。
**通道**：外网官方文本（ego-browser / web-access）。**产物**：新的规则底座文件 +
核验记录（来源 URL + 抓取日期 + 条文原句）。

### 2.1 待核验清单

**CN**

| 待核验 | 用途 | 若成立的后果 |
|---|---|---|
| 审查指南第五部分第一章 4.2/4.3：附图用纸 A4（210×297mm）、页边距 上25/左25/右15/下15mm | 把 `page-contract.ts` 的「实践惯例」升级为「有出处」 | 常数不变，注释与 note 改为引条文 |
| 同上：附图页页码「用阿拉伯数字顺序编写」 | 决定是否落页码（`sheet_*` 参数） | 成立则落页码；不成立则 `sheet_*` 降级为「不做」 |
| 指南一部一章 4.3：编号「标注在相应附图的正下方」+「两幅以上」的文义 | V15/V16 的依据 | 决定单幅是否**不得**编号（CN 侧建议只给 info） |
| CN 是否有图中字高具体数值下限 | V7 的字高分支 | 预计「无」⇒ CN 保留 2.0mm 实践下限（§5.4 有论证） |

**PCT**

| 待核验 | 用途 |
|---|---|
| Rule 11.5（A4）、11.6(c)（可用面 26.2×17.0cm；最小页边距 上2.5/左2.5/右1.5/下**1.0**cm） | PCT 档案的纸面常数 |
| Rule 11.13(a)（不得着色）、11.13(c)（缩 2/3 可辨）、11.13(h)（字高 **≥0.32cm**）、11.13(k)（图序写法）+ 申请人指南 IP 5.141（仅一幅时不编号、不出现 "Fig."） | 字高下限、编号规则 |
| 行政规程 Section 207(b)(iii)（附图页码形如 `1/3`） | 页码写法 |

**US**

| 待核验 | 用途 |
|---|---|
| 37 CFR 1.84(f)(1)/1.84(g)（A4 或 8½×11 in；页边距 上/左 ≥2.5cm、右 ≥1.5cm、下 ≥1.0cm；A4 可用面 ≤17.0×26.2cm） | US 档案的纸面常数 |
| 37 CFR 1.84(p)(3)（字高 **≥0.32cm**）、1.84(k)（缩 2/3 不拥挤；**不得标注实际尺寸或比例**）、1.84(u)(1)（仅一个视图不编号、不出现 "FIG."）、1.84(a)(2)（彩色须呈请）、1.84(t)（页码 `1/3`） | 字高、V12 的「比例标注」、V16、色彩 |

> ⚠️ **不要照抄 deepseek-harness 的数值**。已发现两处需要回条文核对的分歧：
> ① 它的 `uspto` 档案 `margins.rightMm = 15`，而 37 CFR 1.84(g) 的「右 ≥5/8 英寸」≈ 15.875mm；
> ② 它的 `pct`/`uspto` `bottomMm = 10`（=11.6(c) 的 1.0cm）与 Sati 现用的 15mm 不同。
> 两边数值分歧本身就是必须回条文核对的证据。

### 2.2 核验纪律

- **只落已核验的法域**。若 PCT 或 US 的一手文本在实施窗口内拿不到，则该法域**不进档案**，
  工具对该取值显式报错并在文档声明限制（这与 deepseek-harness 对 EPO 的处理同一逻辑：
  「未核实的档案会把工具无法引证的规则写进产品」）。**EPO 明确不列**。
- 每个数值在 `office-profile.ts` 的注释里附条文号，在 `references/*.md` 里附原句。
- 新增 `skills/patent-illustrator/references/pct-drawing-rules.md`（结构照 `uspto-drawing-rules.md`）。

### 2.3 顺手修正既有文档漂移（实测）

| 位置 | 现状 | 应为 |
|---|---|---|
| `references/cn-drawing-rules.md` 规则映射总表 V7 行 | 「画幅 ≤1600px 代理检查」 | 上一轮 P0-4 已改为 A4 可印区 + 毫米字高（`page-contract.ts`），表未同步 |
| 同上 | 缺 V10/V11（权利要求/正文括号规则） | 补两行 |
| `references/uspto-drawing-rules.md` 幅面与边距行 | 「以 eCFR 现行文本为准」 | 核验后写实数并附条文号；**补一行**：图面不得写 `(20)`（11.13(e)/1.84(p)(1)） |

---

## 3. 变更地图

| 编号 | 变更 | 落点 | 契约影响 | 新增/改测试 | 前置 |
|---|---|---|---|---|---|
| **W0-1** | 外部 SVG 安全门（拒 DOCTYPE/ENTITY/CDATA + 大小上限） | 新 `figuregen/svg-safety.ts`；`tool/builtin/patentFigureCheck.ts`、`atoms/handlers/builtin/figure.ts` | 无（schema 不动） | 新 `figuregen/svg-safety.spec.ts`、`figure-gate.spec.ts` 加例 | — |
| **W0-2** | 图面用语规则族 V12/V13/V14 | 新 `figuregen/wording-rules.ts`；`figuregen/check.ts` | 无（规则 id 是内部联合类型） | 新 `figuregen/wording.spec.ts` | — |
| **W0-3** | WASM Graphviz 引擎（dot runner 抽象） | 新 `figuregen/render-viz-wasm.ts`；改 `figuregen/render-graphviz.ts`、`tool/builtin/patentFigureGenerate.ts`（仅 `resolveFigureRenderer` 值域）；根 `package.json` | 无（环境变量，非 schema） | 新 `figuregen/render-viz-wasm.spec.ts` + 一条真实 WASM 断言 | 桌面 spike（§4.3） |
| **W0-4** | `cap01-orchestrator.md` 补 3 个制图工具行 | `assets/prompts/patent/cap01-orchestrator.md` | 无 | `pnpm check:patent-sop` | — |
| **W1-1** | 法域档案 `office-profile.ts` | 新 `figuregen/office-profile.ts` | 内部模块 | 新 `figuregen/office-profile.spec.ts` | **Gate 0** |
| **W1-2** | 提交落版页 `submission-page.ts` | 新 `figuregen/submission-page.ts`；`tool/builtin/patentFigureGenerate.ts`、`patentFigureProject.ts` | 新增附加产物（默认关） | 新 `figuregen/submission-page.spec.ts` | W1-1 |
| **W1-3** | 图号条件化 + 画幅随编号变化 | `figuregen/render-svg.ts`、`dot.ts`、`layout.ts`、`index.ts` | 函数签名变更（内部） | 改 `render.spec.ts`、`dot.spec.ts`（快照更新） | W1-1 |
| **W1-4** | V7 字高按法域 + V15/V16 编号规则 | `figuregen/check.ts`、`page-contract.ts` | 无 | 改 `check.spec.ts`、`check-p1.spec.ts` | W1-1 |
| **W1-5** | `page-contract.ts` 档案化（单一事实源） | `figuregen/page-contract.ts`、`html.ts`、`pixel-gate.ts` | 导出签名变更（内部） | 改 `readback-html.spec.ts`、`pixel-gate.spec.ts` | W1-1 |
| **W1-6** | 三工具入参：`jurisdiction` 扩 `pct`、`figure_count`、`sheet_index`、`sheet_total`、`fit_to_page` | `patentFigureGenerate.ts`、`patentFigureCheck.ts`、`patentFigureProject.ts` | **改 `inputSchema`（重录）** | 改 `tools*.spec.ts`、`us-mode.spec.ts` | W1-1..5 |
| **W1-7** | sidecar 契约扩展（`office`/`caption`/`sheet`/`layout`） | `figuregen/sidecar.ts` | sidecar 版本决策（§5.7） | 改 `sidecar.spec.ts`、`figure-gate.spec.ts` | W1-2 |
| **W1-8** | 生成侧基准扩展（新法域列 + 编号列） | `scripts/figure-benchmark/gen-compliance.ts`、`tests/fixtures/patent/figuregen-bench/baseline.json` | 基线变更 | 改 `gen-compliance.spec.ts` | W1-2..6 |
| **W1-9** | **fixture 重录** | `tests/fixtures/llm-replay/deepseek-v4-flash-basic/` | fixture | `pnpm record:replay` + 重放测试 | W1-6 |
| **W1-10** | 文档：SKILL + references | `skills/patent-illustrator/SKILL.md`、`references/{cn,pct,uspto}-drawing-rules.md` | 无 | `pnpm check:skills` | Gate 0 |

**分组为 PR**：

- **PR-A** = W0-1 + W0-2 + W0-4（零 schema，可并行于 Gate 0）
- **PR-B** = W0-3（零 schema，独立；依赖桌面 spike 结论）
- **PR-C** = W1-1 → W1-5 + W1-10（内部改造，零 schema 变更，PR 内可分 commit）
- **PR-D** = W1-6 + W1-7 + W1-8 + W1-9（**唯一的 schema 变更 PR，含重录**）
- notes 分配见 §1.5。

---

## 4. W0 详情（零 schema 变更）

### 4.1 W0-1 外部 SVG 安全门

**问题（实测）**：`patent_figure_check` 的 `svg_paths` 分支直接 `readFile` 后交给
`readback.parseFigureSvg` 做正则解析；`figure-gate` 的 `detectFigureDrift` 同样直接 `readFile`。
两处都**无大小上限、不拒 DOCTYPE/ENTITY/CDATA**。

**设计**：新 `src/patent/figuregen/svg-safety.ts`

```ts
export const DEFAULT_SVG_MAX_BYTES = 2_000_000;
export type SvgSafetyErrorCode = "unsafe_svg" | "too_large" | "missing_svg_root";
export class SvgSafetyError extends Error { readonly code: SvgSafetyErrorCode; }
/** 拒绝 DOCTYPE/ENTITY/CDATA（大小写不敏感），强制大小上限，要求含 <svg 根。 */
export function assertSafeSvg(text: string, maxBytes?: number): void;
```

**为何放在调用方而非 `parseFigureSvg` 内部**（note 的 Alternatives）：`parseFigureSvg` 的契约是
「只解析本模块两类渲染器的输出」；把安全门塞进去会让它承担两个职责，并让 `render-graphviz.ts`
的内部自检多走一遍无意义的扫描。放调用方则「跨信任边界的每一处读盘」都显式过一次门——
这也正是 deepseek-harness 的做法。

**接线**：
1. `patent_figure_check` 的 `svg_paths` 分支：读盘后 `assertSafeSvg(text)`，异常映射为
   `SatiToolRuntimeError("invalid_tool_input", …)`（与既有读盘失败同码）。
2. `figure-gate` 的 `detectFigureDrift`：`assertSafeSvg` 抛错时**记一条 drift**（沿用既有语义：
   drift 非空 → `InterruptStageError` high，人工决策放行/重生成/退回）。
3. **不接** `render-graphviz.ts` 的内部自检（自己产出的 SVG，不是跨信任边界）。

**测试**（新 `tests/patent/figuregen/svg-safety.spec.ts`）：DOCTYPE / `<!ENTITY` / CDATA / 超限 /
空串 / 缺根；**防误伤**断言：两类渲染器的正常产物必过。`figure-gate.spec.ts` 加
「被注入 DOCTYPE 的 SVG → drift 中断」一例。

**顺带修正**：`readback.ts` 头部注释补一句「调用方须先过 `assertSafeSvg`」，避免下一个人以为
解析器自带护栏。

### 4.2 W0-2 图面用语规则族（V12 / V13 / V14）

**问题（实测）**：Sati 的 V5 只判「label 过长/行数过多」（`COMMENT_LABEL_LINE_MAX=40` /
`COMMENT_LABEL_LINES_MAX=3`）。deepseek-harness 的 `wording-rules.ts` 另判：注释前缀、正文引用、
尺寸标注、比例标注、句末标点、图号入图、非中文词语（含缩写白名单）、数字与括号引号连用、
非阿拉伯数字标号——这些是补正通知书的常见缺陷。

**设计**：新 `src/patent/figuregen/wording-rules.ts`（纯函数）+ `check.ts` 新增三条规则。
**拆三条而非一条**的理由：可分别豁免、法域适用性不同（见下表），且 `FigureCheckFinding` 已有
`rule`/`severity`/`evidence` 结构，语义粒度越细报告越好用。

| 规则 | 内容 | 依据 | 生效法域 | 级别 |
|---|---|---|---|---|
| **V12** 非必需注释 | `注:/注意:/说明:/备注:/提示:` 前缀；`如图/见图/参见图/见附图` 正文引用；尺寸标注（`20mm`、`3 厘米`）；比例标注（`比例 1:2`、`缩小`）；句末标点（`。；;`）；**图号入图**（`图1` / `Fig. 1` / `FIG. 1` 出现在图面词语中） | 细则第 21 条第 3 款 + 指南一部一章 4.3（均已在 `cn-drawing-rules.md` 核验）；比例标注另有 PCT 11.13(d) / 1.84(k) | 全部（比例项仅 pct/us） | warn |
| **V13** 图面用语非中文 | 不含拉丁字母者放行（数字/符号/单位）；全大写缩写放行（`CPU`/`I2C`/`A/D`）；其余（`Input Sensor`、`controller`）报 | 指南一部一章 4.3「附图中的词语应当使用中文，必要时可以在其后的括号里注明原文」 | **仅 cn** | warn |
| **V14** 标号形态 | 非纯阿拉伯数字标号（`S101`、`20a`）；数字与括号/引号/圈号连用 | 指南一部一章 4.3「附图标记应当使用阿拉伯数字编号」；括号连用另有 PCT 11.13(e)、37 CFR 1.84(p)(1) | 非数字标号：全部；括号连用：**仅 pct/us** | warn |

**两处必须写进 note 的取舍**：

1. **V13 只在 cn 生效**。「附图中的词语应当使用中文」是 CN 指南 4.3 的要求；`us` 模式是为出海
   申请服务的（`brief.ts` 输出英文 BRIEF DESCRIPTION、图号用 `FIG. N`），图面词语本就应为英文。
   若对 us 也判「非中文」，会把该模式的正常产物全量报 warn。
2. **V14 的括号连用只在 pct/us 生效**。Sati 自家 SKILL 推荐的图面惯用形是 `处理模块(20)`
   （`render-svg` 也据此渲染），而 CN 法条未明文禁止括号 ⇒ 对 cn 判这一条会给全库默认写法
   报 warn。同时把「同一份图若也用于 PCT/US，图面不得写 `(20)`」补进
   `references/uspto-drawing-rules.md`（现有文档缺这条实质约束）。

**边界**：只吃**图面词语**（label 与边标签），不吃说明书正文——正文侧的括号规则已由 V10/V11
覆盖，不得重复报。

**测试**（新 `tests/patent/figuregen/wording.spec.ts`）表驱动 + 防误伤断言：
`式(1)`/`步骤(1)`/`CPU`/`I2C`/`24V`/`处理模块(20)`（cn 下不报）/`Input Sensor`（cn 报、us 不报）/
`比例 1:2`（us 报）/`图1` 入图。`check.spec.ts` 断言 V12–V14 的 finding 结构与 rule id。

### 4.3 W0-3 WASM Graphviz 引擎

**问题（实测）**：Sati 的 `render-graphviz.ts` 是**自带 DOT 生成 + 后处理**（`buildFigureDot`
→ `runDot` 子进程 `dot -Tsvg` → `postProcessGraphvizSvg` 归一化颜色 + 黑白扫描 + 注入 `data-ref`
→ `parseFigureSvg` 自检），要更好的布局就得 `brew install graphviz`，缺失即 fail-closed。
deepseek-harness 打包 `@viz-js/viz`（WASM，无系统依赖）作默认，CLI 仅兜底 png/pdf。

**设计**：**只替换渲染后端，加工链一条不动**。

```ts
// render-graphviz.ts 抽出（新类型）
export type DotRunner = (dot: string) => Promise<string>;   // 返回 SVG 文本
export function createSubprocessDotRunner(dotPath: string, timeoutMs?: number): DotRunner;
// 新 render-viz-wasm.ts
export function createWasmDotRunner(deps?: { loadViz?: VizLoader }): DotRunner;
```

`renderFigureSvgWithGraphviz(spec, { runner | dotPath, jurisdiction, timeoutMs })`：runner 缺省时
按 `dotPath` 造子进程 runner（**向后兼容现有调用面与单测注入**）。`postProcessGraphvizSvg` +
readback 自检**完全复用**（这是 Sati 相对 DSH 的结构优势：DSH 的 dot-builder 与渲染器绑在一起，
Sati 的加工链对「谁产出的 SVG」无感）。

`SATI_FIGURE_RENDERER` 值域加 `graphviz-wasm`（env，**零 schema**）；`resolveFigureRenderer`
（`patentFigureGenerate.ts`）同步；**默认仍为 `builtin`**（不改默认，避免行为突变与快照全量变更）。

**必做的 spike（写代码前）**——三项实测，任一不符则扩归一化器或 fail-loud 声明限制：

| 检查项 | 为何 | 不符时的处置 |
|---|---|---|
| WASM 输出的颜色写法为 `#000000`/`black`/`rgb(0,0,0)` 中哪一种 | Sati 的 `assertBlackWhite` 只认 `none`/`#000000`/`#ffffff`，`normalizeColors` 只把 `black`/`white` 关键字转 hex | 扩 `normalizeColors` 支持 `rgb(r,g,b)`；**不得**放宽 `assertBlackWhite` |
| 输出含 `<title>` 且节点分组为 `<g class="node">` | `postProcessGraphvizSvg` 靠 `<title>` 定位节点、`readback` 靠 `class="node"` 识别分组；WASM 对应新版本 Graphviz，结构可能微调 | 调整定位策略或该模式 fail-loud 并声明 |
| 根元素有 `viewBox` | `parseCanvasSize` 依赖 viewBox 定画幅 | 该模式 fail-loud |

**桌面端 spike（与代码 spike 并行）**：在 `apps/desktop` 打包产物上跑一次
`SATI_FIGURE_RENDERER=graphviz-wasm` 出图。若 asar 内 WASM 加载失败：
- 优先查 `electron-builder.yml` 的 `asarUnpack` / `files` 配置补入 `@viz-js/viz`；
- 若仍不可行 ⇒ **降级为「服务端/CLI 可用，桌面端该模式报错并引导用内置渲染器或系统 dot」**，
  在 SKILL 与 note 中如实声明（不静默回退）。

**测试**：
- `tests/patent/figuregen/render-viz-wasm.spec.ts`：注入替身 loader（成功/加载失败不缓存/
  渲染抛错/取消信号）；断言失败路径的文案含「改用内置渲染器或系统 graphviz」。
- **一条真实 WASM 断言**（唯一真跑 WASM 的测试，无外部依赖）：同一 `FigureSpec` 经 builtin 与
  wasm 两路出图，都把 data-ref 回读出来、都过黑白扫描、`图N` 标注一致。这是本项的关键回归护栏。

**依赖**：根 `package.json` `dependencies` 增 `@viz-js/viz`（lazy `import()`，不进启动路径）。

### 4.4 W0-4 编排手册补制图工具行（顺手修覆盖缺口）

**实测**：`assets/prompts/patent/cap01-orchestrator.md:119-120` 的工具表只列了
`analyze_patent_figure` / `search_patent_figure`（分析侧），**没有**
`patent_figure_generate` / `patent_figure_check` / `patent_figure_project`（生成侧）。
编排手册不引导 ⇒ 主代理不会主动配图（只有 `patent_drafting_v1` 的 `figure_generate` 阶段会触发）。

**设计**：在工具表补三行（生成/核验/投影），并加一条调度约束：「附图定稿前必须经
`patent_figure_check`；禁止自建脚本代替」。改完跑 `pnpm check:patent-sop` 确认引用真实存在。

---

## 5. W1 详情（含唯一的 schema 变更与重录）

### 5.1 W1-1 法域档案 `office-profile.ts`

**设计**（照 deepseek-harness 的数据形状，但**数值全部来自 Gate 0 的核验结果**）：

```ts
export const TARGET_OFFICES = ["cnipa", "pct", "uspto"] as const;   // 只列已核验者
export type TargetOffice = (typeof TARGET_OFFICES)[number];

export type OfficeProfile = {
  readonly office: TargetOffice;
  readonly paper: { widthMm: number; heightMm: number };
  readonly margins: { topMm: number; leftMm: number; rightMm: number; bottomMm: number };
  /** 图中数字与字母的最小字高（毫米）；CN 无条文数值时为 undefined。 */
  readonly minCharHeightMm?: number;
  /** CN 侧为了不倒退而保留的实践下限（明确标注为惯例，非法条）。 */
  readonly practicalMinCharHeightMm?: number;
  readonly captionStyle: "figure-number" | "fig" | "fig-upper";
  /** 是否仅在附图两幅以上时标注图号。 */
  readonly captionOnlyWhenMultiple: boolean;
  /** 是否禁止单幅编号（pct/uspto：不得出现 Fig./FIG.）。 */
  readonly forbidCaptionWhenSingle: boolean;
  readonly sheetNumbering: "figure-pages" | "sheet-of";
  readonly reductionRatio: number;   // 2/3
};

export function officeProfile(office: TargetOffice): OfficeProfile;
export function figureCaption(p: OfficeProfile, figureNo: number, figureCount: number): string | undefined;
export function sheetNumberText(p: OfficeProfile, index: number, total: number): string;
```

- 单幅/多幅的取号语义与 DSH 一致：`captionOnlyWhenMultiple && figureCount < 2` ⇒ `undefined`；
  `forbidCaptionWhenSingle` 用于 V16 的判定（**不是**渲染时静默丢弃——渲染不画、核验报错，
  两条路径都体现规则）。
- **EPO 不在表内**，模块注释写明原因（一手文本不可得）。
- 与 `references/*-drawing-rules.md` 的条文号一一对应，注释即溯源。

### 5.2 W1-2 提交落版页 `submission-page.ts`

**设计**：`buildSubmissionPage({ drawingSvg, profile, caption?, sheetNumber?, bodyFontSize?, … })`
→ `{ svg, metrics, warnings }`。

- 解析图形 SVG 的 `width`/`height`/`viewBox`（单位 mm/cm/in/pt/px/无单位）→ 毫米；按档案的
  版心等比缩放（上限 4× 防放大失真，超限出 warning）。
- 版心内**居中**放置图形；图形正下方 `captionGapMm + captionFontMm` 处画居中图号；版心底部画
  页码；均 `fill="#000000" stroke="none"`。
- `metrics`：`pageScale` / `drawingWidthMm` / `drawingHeightMm` / `placedWidthMm` /
  `placedHeightMm` / `charHeightMm` / `reducedCharHeightMm`（字高 = 正文字号 × 用户单位→mm 比 ×
  0.7（大写字母高/字号经验比）× `pageScale`）。
- **仅 SVG** 路径可落版：png/pdf 不在 Sati 产物内，无需处理。

**与 DSH 的有意差异（E4，写进 note）**：DSH 默认 `fit_to_page: true`（它的工具只产一张图，
落版即产物）。Sati 的产物契约是 `<name>-figN.svg` + sidecar（`figure-gate` 依赖它做漂移检测），
默认改写会让既有调用方与门禁同时受影响 ⇒ **Sati 默认 `false`**，`fit_to_page: true` 时
**额外**产 `<name>-figN-page.svg` 并把落版摘要写进 sidecar。落版页是「给提交/打印用的整页视图」，
图形 SVG 仍是机器可读的主产物。

**必须专项验证的耦合**：`figure-gate` 的 `detectFigureDrift` 用 `parseFigureSvg` 回读 sidecar
声明的 SVG 并比对 `data-ref` 集合。落版页把图形包进嵌套 `<g transform>`，`readback` 的栈式扫描
**应**仍能命中 `id="n-<nodeId>"` 分组，但这是**推断不是事实** ⇒ 加一条断言：落版页也能被
`parseFigureSvg` 正确回读（figureNo 与 ref 集合与 spec 一致）。

**测试**（新 `submission-page.spec.ts`）：单位解析全分支（mm/cm/in/pt/px/无单位/仅 viewBox 回退）；
缩放上限 warning；图号在图下方/页码在版心底的坐标断言；`fit_to_page: false` 只核算不改写；
三法域各一组；**落版页可回读**。

### 5.3 W1-3 图号条件化 + 画幅随编号变化

**设计**：
- `render-svg.ts`：`figureCaption` 迁至 `office-profile.ts`（单一实现）；`renderFigureSvg(spec, { profile })`。
- `layout.ts`：`layoutFigure(spec, options?: { caption?: boolean })` —— caption 带（`CAPTION_H = 40`）
  **只在需要编号时计入画幅**。
- `dot.ts`：`buildFigureDot(spec, { profile, caption?: string })` —— 需要编号时用 `label` +
  `labelloc="b"`，否则不输出 caption 属性。
- `index.ts` barrel 同步导出。

**代价（必须写进 note）**：单幅图的画幅会**变小**（少 40px）⇒ 既有渲染快照、`check` 的 V7
纸面尺寸判定、`figuregen-bench/baseline.json` 全部变动。这是**行为变更**，须同 PR 集中更新，
且在 note 的 Consequences 里点名。

### 5.4 W1-4 check.ts：字高按法域 + 编号规则 V15/V16

- **V7 字高分支**：`minCharHeightMm` 来自档案。**CN 的处理**：条文无具体数值，但为不倒退，
  保留 `practicalMinCharHeightMm = 2.0`，message 明确写「实践下限（非法条数值）」；
  `pct`/`uspto` 用 3.2mm 并引 11.13(h) / 1.84(p)(3)。（note 的 Alternatives 记录
  「改为 CN 不判」为何被否。）
- **V15 多幅未编号（fail）**：`figureCount >= 2` 且任何一幅无 caption ⇒ fail。依据：指南 4.3（cn）/
  11.13(k)（pct）/ 1.84(u)（us）。
- **V16 单幅却编号（按法域）**：`figureCount < 2` 且有 caption ⇒ `pct`/`uspto` → warn
  （不得出现 Fig./FIG.）；`cn` → info（4.3 只是「才编号」，非禁止）。
- **V17 页码缺失**：仅在 Gate 0 核验「页码为强制」时启用（CN 五部一章 4.3 顺序编号 /
  207(b)(iii) / 1.84(t)）；否则该规则整条不做。
- **pct 下 V10/V11 的处置**：V10/V11 依据的是 CN 细则第 22 条与中文正文惯例。PCT 体例下未核验
  ⇒ **pct 时跳过 V10/V11** 并在 `specFaces` 的 `reason` 里注明「pct 未适用 CN 括号规则」，不猜。
  V8（摘要附图）/V9（实用新型）在 pct 下同样跳过（沿用 `us` 的分支写法）。

### 5.5 W1-5 `page-contract.ts` 档案化（消灭第二套常数）

**现状**：`page-contract.ts` 的 `PAGE_MARGIN_*` / `PRINTABLE_*` / `MIN_PRINTED_FONT_MM` /
`uniformFigureZoom` 是**单一套**常数，被 `check.ts`（V7）、`html.ts`、`pixel-gate.ts` 三处消费；
边距注释自陈「实践惯例」。档案化后三者都必须按法域取。

**设计**：
- `office-profile.ts` 只放**数据**；
- `page-contract.ts` 保留**派生纯函数**：`printableArea(profile)`、`uniformFigureZoom(sizes, profile)`、
  `printedFontMm(px, zoom)`，并保留 `DEFAULT_OFFICE: TargetOffice = "cnipa"` 与其派生常量
  ⇒ 既有调用方一期不必全改，二期按法域显式传 profile。
- `html.ts` 的 `@page` 边距与 `.figure-box svg { max-height }` 从 profile 取。
- `pixel-gate.ts` 的 `PRINTABLE_*` 改从 profile 取（调用方未给法域时默认 cnipa）。

**测试**：`readback-html.spec.ts` 断言 `@page` 边距与档案一致（防两处漂移，扩展为按法域参数化）。

### 5.6 W1-6 三工具入参（唯一的 schema 变更）

| 字段 | 变更 | 说明 |
|---|---|---|
| `jurisdiction` | enum `["cn","us"]` → `["cn","us","pct"]`（**保留字段名**） | 语义是「目标受理局/指定局」；不改名为 `target_office`（note 记录取舍：改名要同步 SKILL/文档/sidecar 三处，收益只是措辞） |
| `figure_count` | 新增 `integer` | 本案附图总幅数；缺省取 `figures.length`（Sati 是「一次调用产 1..N 幅」，多数场景可推导）。**存在理由**：分次调用生成附图、以及 `patent_figure_project`（一次一图）无法自行得知总数 |
| `sheet_index` / `sheet_total` | 新增 `integer` | 附图页序号/总数；缺省 1/1。仅当 Gate 0 核验页码强制时才在落版页落页码 |
| `fit_to_page` | 新增 `boolean` | 默认 `false`；`true` 时额外产落版页（§5.2） |

- 三个工具（`patentFigureGenerate` / `patentFigureCheck` / `patentFigureProject`）统一应用。
- 工具**顶层** `description` 同步更新（法域取值、图号条件化、落版页、V12–V16 的检查面）——
  顶层 description 不进 digest，但仍与 schema 同 PR 改，避免二次重录的错觉。
- `patentFigureGenerate` 的 `format` **不动**（不新增 `"page"` 值，避免值域膨胀）。
- 运行时类型收窄抽成一个 `toJurisdiction(input)` 共用，避免三处漂移。

### 5.7 W1-7 sidecar 契约扩展

新增字段（**可选**，保持向后兼容）：`office`、`caption`、`sheet`（`{ index, total, text }`）、
`layout`（落版摘要）。

**版本决策**：`FIGURE_SIDECAR_VERSION` **不升版**。新增字段为可选，`parseFigureSidecar` 只校验
最小结构（对额外字段宽容）；升版会让既有案卷的 sidecar 直接抛错（解析器对版本不等即抛），
弊大于利。写进 note。

`figure-gate`（`atoms/handlers/builtin/figure.ts`）**代码不改**：`jurisdiction` 类型拓宽后自动生效
（pct 时跳过 V8/V9/V10/V11）；落版信息只进报告，不参与判定。

### 5.8 W1-8 生成侧基准扩展

既有护栏 `scripts/figure-benchmark/gen-compliance.ts` + `tests/fixtures/patent/figuregen-bench/baseline.json`
必须扩展，否则本轮改动没有回归护栏：

- 基准用例按**法域 × 图幅数**扩矩阵（cn-单幅 / cn-两幅 / pct-两幅 / us-单幅 …），断言新规则
  （V15/V16）与字高分支的命中数。
- 基线用 `--update` 刷新；**语义锚点不随基线放宽**（沿用既有纪律）：「单幅 pct 必无 caption」
  「两幅 cn 必有 caption」「pct 字高 <3.2mm 必报」「落版页可回读」。
- 既有列（超框/字高/V4/V10-V11/LR 画幅）保留，值因 §5.3 的画幅变更而变，需在 PR 描述里逐项
  说明「哪一例、哪一项、从多少到多少」。

### 5.9 W1-9 fixture 重录（操作手册）

沿用 `docs/patent-figure-hardening-plan.md` §7 的既有手册，本轮增量约束如下：

```sh
FIX=tests/fixtures/llm-replay/deepseek-v4-flash-basic

# 0) 前置：确认 main 上重放测试为绿（否则先修，录出来的记录会立即失配）
pnpm build && node --test dist/tests/test-support/llm-replay-real.spec.js

# 1) 改代码后确认重放测试确实红了（证明重录必要）

# 2) 清旧记录（录制是追加语义，不删会重复且 index 冲突）
rm "$FIX/records.jsonl"

# 3) 真实录制——provider/model 必须与重放测试 pin 的一致
PILOT_AGENT_MODEL=deepseek/deepseek-v4-flash \
  SATI_LLM_REPLAY_RECORD_ROOT="$FIX" \
  node --import tsx scripts/record-real-fixture.ts "请用一句话介绍你自己，以及你能为专利工程师提供哪些帮助。"

# 4) 结构校验 + 重放转绿
pnpm record:replay "$FIX"
pnpm build && node --test dist/tests/test-support/llm-replay-real.spec.js
pnpm test
```

**注意事项**：

- 必须用重放测试 pin 的 `provider/model`（`deepseek/deepseek-v4-flash`），用 `PILOT_AGENT_MODEL`
  对齐；本机 `~/.sati/sati.yaml` 若已切别的模型会录出错误键。
- 录制期间**不得**临时改注册表开关，否则录出的 `toolNames` 与测试装配不符。
- **本轮新增纪律**：除本 PR 外，任何后续 PR 若再改任一 `inputSchema` 都会再次破坏该 fixture
  ⇒ 评审时把「本 PR 是否改了 inputSchema」作为固定检查项。
- 录制产物不得含 API key；提交前 `git diff` 目视确认 fixture 只含 `manifest.json` + `records.jsonl`。
- CI 无 key，重录必须本地完成并随 PR 提交。

### 5.10 W1-10 文档同步

- `skills/patent-illustrator/SKILL.md`：法域表改 `cn/us/pct` 并写清图号写法与字高下限；
  图号条件化（单幅不编号、US/PCT 单幅不得出现 Fig./FIG.）；`fit_to_page` 与落版页产物；
  渲染器表加 `graphviz-wasm`；规则表补 V12–V16；「Sati Migration Note」改为现状陈述
  （P0–P3 已全部落地）。
- `references/cn-drawing-rules.md`：修 §2.3 的三处漂移。
- `references/uspto-drawing-rules.md`：补核验后的实数与条文号；补「图面不得写 `(20)`」。
- 新增 `references/pct-drawing-rules.md`。
- `assets/prompts/patent/cap01-orchestrator.md`：W0-4 的三行 + 一条调度约束。

---

## 6. 验收总表

```sh
# 窄面快跑（渲染/规则/门禁）
node --test dist/tests/patent/figuregen/*.js dist/tests/patent/figure-gate.spec.js

# 聚合门禁（不含 test）+ 测试
pnpm check && pnpm test

# 生成物与度量（易漏项）
pnpm measure:update            # 新增 .ts 必须，否则 check:techdebt-metrics 红
pnpm gen:doc-claims            # 跑一次确认幂等（预计无 diff）
pnpm record:replay "$FIX"      # 仅 PR-D

# 生成侧基准
pnpm tsx scripts/figure-benchmark/gen-compliance.ts
```

| 项 | 判据 |
|---|---|
| W0-1 | 注入 DOCTYPE 的 SVG 在 `svg_paths` 与 `figure-gate` 两处都被拒；两类渲染器正常产物不误伤 |
| W0-2 | V12/V13/V14 各命中一类缺陷；`处理模块(20)` 在 cn 下不报、在 us 下报；`Input Sensor` 在 cn 报、us 不报 |
| W0-3 | wasm 与 builtin 两路出图都过黑白扫描且 data-ref 可回读；`SATI_FIGURE_RENDERER=graphviz-wasm` 在无系统 dot 的机器上能出图；桌面 spike 有结论（通过 / 明确降级并声明） |
| W0-4 | `pnpm check:patent-sop` 绿；编排手册含三行制图工具 |
| W1-1 | 每个法域数值都有条文号；EPO 缺席且注释说明原因；未核验法域取值时显式报错 |
| W1-2 | 落版页图号在图形正下方、页码在版心底；`fit_to_page: false` 不改写画布；落版页可被 `parseFigureSvg` 回读 |
| W1-3 | 单幅图无 `图1`；两幅图有 `图1`/`图2`；画幅随编号变化（快照已更新） |
| W1-4 | 单幅 `pct` 打 `Fig. 1` → V16 warn；两幅未编号 → V15 fail；2.5mm 字高在 `us` 报、在 `cn` 按实践下限告警 |
| W1-5 | `@page` 边距与档案同源（改档案会同时改 HTML），无第二套常数 |
| W1-6 | 三工具 `jurisdiction` 接受 `pct`；`figure_count` 缺省等于 `figures.length` |
| W1-7 | 新 sidecar 字段可读；旧 sidecar 仍可解析（不升版） |
| W1-8 | 基线逐项一致 + 语义锚点绿（不随 `--update` 放宽） |
| W1-9 | `pnpm record:replay` 通过；重放测试绿；`manifest.json` 的 schema 与代码一致 |
| W1-10 | `pnpm check:skills` 绿；规则底座无漂移 |

---

## 7. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| **Gate 0 拿不到 PCT/US 一手文本** | 高 | 该法域不进档案 + 工具显式报错 + 文档声明；EPO 已按此处理。**不得**照抄 deepseek-harness 数值（已发现两处分歧） |
| 画幅变更（§5.3）导致快照/基准全量变动 | 中 | 单 PR 集中更新；note 的 Consequences 点名；PR 描述逐项列「从多少到多少」 |
| WASM 输出结构与 CLI 不同 ⇒ `postProcessGraphvizSvg`/readback 失败 | 中 | 写码前 spike 三项；不符则扩归一化或 fail-loud 声明；**不放宽 `assertBlackWhite`** |
| 桌面端 asar 内 WASM 加载失败 | 中 | 先查 `asarUnpack`；不可行则降级声明（服务端可用、桌面端报错引导） |
| 落版页破坏 `figure-gate` 的漂移检测 | 中 | 专项断言（§5.2）；若确实解析不到，则 sidecar 只记**图形 SVG** 的路径用于漂移检测 |
| 重录 PR 与 main 上其他 schema 变更相互等待 | 中 | 排期上把 PR-D 放最后，前置确认 main 绿；PR-D 内不夹带其他 schema 改动 |
| 新增 3 条规则造成告警噪音（尤其 V13/V14） | 中 | 法域适用性逐条限定（§4.2）+ 防误伤断言；只提示不改写输入 |
| `measure:update` 漏跑 | 低 | 收尾清单显式列；`check:techdebt-metrics` 会红 |

---

## 8. 明确不做 / 延后（边界诚实）

**本轮不做**

1. **`semantic` 彩色模式**（4.3「必要时可以提交彩色附图」）：会动摇「构造期黑白不变式」这条贯穿
   渲染/核验/像素门的基线，且需先核验各法域的彩色提交程序（37 CFR 1.84(a)(2) 呈请、
   PCT 11.13(a) 禁止）。要立须单独立项。
2. **图型扩展**（状态图、组件层级图、电路图、曲线图、DOT 通路的剖视图、时序图、外观设计六面视图）：
   属「出图能力侧」，与合规侧正交。其中**外观设计需另行核验 37 CFR 1.152** 等条文。
3. **图外引线标号**（deepseek-harness 的 `leader-line.ts`，906 行含候选锚点择位、碰撞规避、
   越界扩画布、退化内嵌告警）：工程量大且与落版/画幅耦合，建议落版稳定后单独立项。
4. **多面板 `panels`（FIG.1A/1B）与跨图自动续号 `figure_family`**：需要新的入参契约与标号分配
   算法，与 §5.6 的 schema 变更**不得**混在一次重录里（否则出问题无法二分定位）。
5. **栅格输出（png/pdf）**：与「Sati 只出矢量 + Chromium 打印出 PDF」的既有交付契约冲突；
   且 Sati 已有 `pixel-gate` **核验**栅格图，产出栅格图的价值不明确。
6. **EPO 档案**：不核验不落地。
7. **`html.ts` 的整册打印版式重构**：本轮只把它接到档案（§5.5），不重做版式。

**本轮之后建议立刻排（本轮已为其铺好路）**

- ~~W0-3 稳定后，把「默认渲染器是否切换为 `graphviz-wasm`」作为独立决策~~ → **已完成**
  （2026-09-22，后续叠加分支）：量化对比 21 用例 × 3 后端，结论**保持 `builtin` 默认**、
  graphviz 系维持 opt-in，并给出「字高余量不足时改走 `graphviz-wasm`」的判据；对比中还修掉
  graphviz 通路的 fail-closed 缺陷（连字符节点 id）。见
  `docs/notes/implemented/2026-09-22-figure-default-renderer-decision.md` 与
  `scripts/figure-benchmark/renderer-compare.ts`（可复算）。
- 引线标号（第 3 项）——它是「剖面线/标记线与主线条不得互相妨碍」（4.3 明文）唯一缺的落地手段。
- 图型扩展按「DOT 通路先（状态图/层级图，复用 `dot.ts`）→ 矢量通路后（电路/曲线/剖视/时序）」
  分批。

---

## 附录 A：Gate 0 核验来源清单（**已完成**，抓取日期均为 2026-09-22 UTC）

| 法域 | 条文 | 核验结论（要点） | 来源（URL） |
|---|---|---|---|
| CN | 指南五部一章 4.1/4.2/4.3 | 80 克胶版纸；规格 297×210mm（A4）；页边 上25/左25/右15/下15mm（下为"从页码下沿至页边"） | `cnipa.gov.cn/art/2023/12/21/art_526_189193.html` + 该页全文 PDF（局令第 78 号，2024-01-20 施行） |
| CN | 指南五部一章 5.2/5.6 | ⚠️ 5.2 的"字高不低于 3.5 毫米"是**纸件申请正文**要求（非附图专有）⇒ CN 不设条文值；5.6 页码为**顺序阿拉伯数字**（非 `1/3`），置于每页下部页边的上沿并左右居中 | 同上 |
| CN | 指南一部一章 4.3 | 「附图总数在**两幅以上**的，应当使用阿拉伯数字顺序编号…该编号应当标注在相应附图的**正下方**」；「附图标记应当使用阿拉伯数字编号」；「附图中的词语**应当使用中文**，必要时可以在其后的括号里注明原文」；「一般使用黑色墨水绘制，**必要时可以提交彩色附图**」（⇒ 现行文本无"不得着色"）；无附图中文字的字高数值 | 同上（与本地 2023 全文抽取本互校一致） |
| PCT | Rule 11.5 / 11.6(c) | A4；可用面 ≤26.2×17.0cm；最小边距 上2.5/左2.5/右1.5/下1.0cm | `wipo.int/pct/en/texts/rules/r11.html` |
| PCT | Rule 11.13(a)(c)(d)(e)(g)(h)(k) + 11.11(a) | 禁止着色；缩 2/3 可辨；⚠️ 11.13(d) **只**说"比例须用图形表示"，**不禁止**标注（"actual size / scale ½ 不得出现"在指南 **5.150**）；括号/圆圈/引号不得与数字连用；字高 ≥0.32cm；图序阿拉伯数字连续；图面文字限于"不可缺的短词" | 同上 |
| PCT | 申请人指南 IP 5.141 | 图号前冠 `Fig.`（"whatever the language"）；**单幅不编号、`Fig.` 不得出现**；部分视图用"同号 + 大写字母"（Fig. 7B） | `wipo.int/documents/d/pct-system/docs-en-gdvol1.pdf`（第 39 页） |
| PCT | 行政规程 Section 207(b)(iii) | 图纸页单独起编，`两个阿拉伯数字 + 斜线`（1/3, 2/3, 3/3） | `wipo.int/en/web/pct-system/texts/ai/s207` |
| US | 37 CFR 1.84(f)(1)(g)(p)(3)(t)(u)(k)(a) | A4；页边 上/左 ≥2.5cm(1 inch)、右 ≥1.5cm(5/8 inch)、下 ≥1.0cm(3/8 inch)，sight ≤17.0×26.2cm；字高 ≥.32cm(1/8 inch)；页码 `1/3`；⚠️ 「Where only a single view is used … **it must not be numbered and the abbreviation "FIG." must not appear**」；标记不得与括号/引号/圈号连用 | `ecfr.gov/api/versioner/v1/full/2026-09-01/title-37.xml?part=1&section=1.84`（+ govinfo `CFR-2024-title37-vol1-sec1-84.xml`、MPEP `uspto.gov/web/offices/pac/mpep/s608.html` 三方互校） |
| — | EPO | **未取得**（EPC Rule 46/47 与 EPO Guidelines 一手文本 403）⇒ EPO **不进档案** | — |

> 已实测的坏消息（§1.4）：本地知识库 `:8100` **不含**上述域外条文，`:8001` 当前 503。
> 核验必须走外网官方文本，逐条留痕——**已照此执行**：三法域全部走官方一手文本，CN 另与本地
> 2023 全文抽取本互校、US 经 eCFR/govinfo/MPEP 三方互校。逐句原句落在
> `skills/patent-illustrator/references/{cn,pct,uspto}-drawing-rules.md`。

## 附录 B：与 deepseek-harness 的设计差异及取舍（供评审对照）

| 议题 | deepseek-harness | 本方案 | 理由 |
|---|---|---|---|
| 落版默认值 | `fit_to_page` 默认 `true` | 默认 `false`，落版页为附加产物 | Sati 的 SVG + sidecar 已是稳定契约，`figure-gate` 依赖它；默认改写会让调用方与门禁同时受冲击 |
| 规则与核算的落点 | `compliance.ts` 与核验分两处 | 规则统一在 `check.ts`，核算降为共用纯函数 | 避免「同一规则两处真相」；Sati 的 finding 已带 rule/severity/evidence |
| 色彩策略 | `grayscale`/`semantic` 双模 + 档案色彩策略 | 维持构造期黑白不变式，不做 semantic | 见 §8 第 1 项 |
| 图型覆盖 | 状态图/层级图/电路/曲线/剖视/时序/外观设计/模板/多面板 | 本轮不扩 | 见 §8 第 2、4 项 |
| 引线标号 | `leader-line.ts` 外置标号 + 碰撞规避 | 本轮不做；**补一条文档约束**（PCT/US 图面不得写 `(20)`） | 工程量独立；但至少把已发现的合规冲突写进规则底座 |
| WASM 引擎 | 默认 WASM、CLI 兜底 | 作为**可选**引擎（`graphviz-wasm`），默认仍 builtin | 不突变默认行为与快照；先验证再谈切换默认 |
| 渲染器包装 | dot-builder 与渲染器绑定 | 抽 `DotRunner` 接口，加工链（黑白扫描 + data-ref 注入 + readback 自检）与后端解耦 | Sati 既有加工链是结构优势，改后端不改链 |
| 法域 | cnipa/pct/uspto | 同（数值另行核验，不照抄） | 已发现 DSH 的 `uspto.rightMm=15` 低于 1.84(g) 的 5/8 英寸；分歧即须回条文 |
| 编排接线 | 靠 preset 提示词 + 无阶段级门禁 | 已有 `figure-gate` 工作流门禁（DSH 无）；本轮补 `cap01` 工具表 | Sati 在这条线上领先，不回退 |

---

## 9. 实施结果与偏离（2026-09-22）

**核验**：`pnpm check` 全绿；`pnpm test` 全量绿（含 `llm-replay-real` 无 key 重放转绿）；
生成侧基准与语义锚点绿；`docs/code-facts.md` / `docs/technical-debt/metrics.md` /
`docs/event-producer-consumer.md` 已按门禁回填。

### 9.1 与本文档计划不一致的地方（评审请重点看）

| # | 计划 | 实施 | 原因 |
|---|---|---|---|
| 1 | §1.2 预测 `pnpm gen:doc-claims` **不触发** | **触发**（`docs/code-facts.md` 的 `src/patent/` 文件数 178 → 184） | 该表有 `src/patent/` 的**模块文件数**行，新增模块文件即变；预测错在"计数矩阵无图模块文件数项" |
| 2 | V14 判「非纯阿拉伯数字标号（`S101`、`20a`）」 | 只判 `20a`（小写字母后缀）；`S101` 类**字母前缀步骤标号不判** | `cn-drawing-rules.md` §3 把 `S100、S110` 登记为方法步骤的既有代理惯例，且其不承载 `ref`（不是附图标记）；对每张流程图报一遍会让真缺陷淹没。反过来，**大写**后缀（`20A`）也不判——37 CFR 1.84(u)(1) 与 PCT 指南 IP 5.141 明文允许"同号 + 大写字母"表示部分视图（Fig. 7B） |
| 3 | V16 对 cn 报 **info** | V16 **对 cn 完全不判** | 与 #4 同源：CN 单幅保留图号是本模块的默认产物（且附图说明引用"图1"），对自家正常产物每天报 info 是噪音；"4.3 只把编号义务系于两幅以上、未禁止单幅"已写进档案注释与规则底座 |
| 4 | §5.1 `captionOnlyWhenMultiple` 未定 CN 取值 | **cnipa = false**（单幅保留"图1"），pct/uspto = true | 4.3 的文义是"两幅以上**应当**编号"，不是"单幅**不得**编号"；取 false 同时把改动面收在 pct/us（CN 快照与基准数值零变动）。**有意与"图号一律条件化"的字面读法不同** |
| 5 | 计划未提"图号回读契约" | **新增根元素 `data-figure-no`** + `parseFigureSvg` 先读属性再回落文本 | 图号可见性条件化后，"图尾 `<text>图N</text>`"在单幅 pct/us 上不存在，会让漂移检测与 `svg_paths` 回读全线失效。属性=机器契约、可见标注=法域形态，`numbered` 字段把两者分开 |
| 6 | §5.2 落版页画"图号在图下、页码在版心底" | 页面层**不再画**图号（图形自带），只补页码 | 实现中发现会出两个"图1"（图形标注带 + 页面层），且与"单幅不得出现 Fig."冲突。`caption` 选项保留给"外部图形无图号"的场景 |
| 7 | §5.4 V17「页码缺失」 | V17 = **多页附图未声明页码/序号越界** | 逐案"全案都没有页码"属错误归因（Sati 在只出单幅 SVG 的路径上不合成最终图页）；只在调用方声明了页数却没给序号时判 |
| 8 | 文件清单未列 `brief.ts`、`cad/render-cad.ts` | 两者都改 | 图号条件化若不改 `brief.ts`，会出现"图不编号而附图说明写 FIG. 1"的自相矛盾；`cad` 渲染器同样要吃档案才不会三处写法各异 |
| 9 | §5.3 未提 `layoutFigure` 的默认值 | `layoutFigure(spec, { caption })` 缺省**计入**标注带（true） | 保持既有直接调用方（含 CAD 路径）行为不变，只有显式传 false 才省 40px |
| 10 | 计划把它当"PR"分四个 | 四个**提交**在同一分支 `feat/figure-harness-parity`（消息即 PR-A/C/D/B 四组） | 便于一次性交付与本地验证；需要拆 PR 时按提交切分即可（`git cherry-pick`） |
| 11 | — | W0-3 由子代理在**隔离 worktree** 实施后合并（`render-graphviz.ts` 与 `patentFigureGenerate.ts` 有两处冲突，已手工合并：`DotRunner` 抽象 + `figureCount` 透传 + `data-figure-no` 注入三者共存） | 并行推进以缩短墙钟时间；冲突点即"两次改动都碰同一函数的调度行" |

### 9.2 新增事实（计划未预见，值得记录）

- **`@viz-js/viz` 没有独立 `.wasm` 文件**：wasm 以 JS 字符串内嵌在 `dist/viz.js`（`findWasmBinary()`/`binaryDecode`）。因此"asar 内 WASM 加载失败"这个计划里的中风险项**不存在**——桌面端结论是不需要改任何打包配置（asar 只装 desktop 自己的产物，后端跑在解包的 `sati-main/` 里；已实测"按 release.sh 口径 tar 打包 → 解包目录 `import()` → 渲染成功"）。
- **WASM 输出与系统 dot 的结构差异只有一处**：`graph0` 分组的 `<title>`（系统 dot 有"图1"、WASM 没有），但加工链只按**节点** `<title>` 定位、图号走图尾文本，故无影响。颜色为小写 hex、`<g class="node">` 与 `viewBox` 均一致 ⇒ 加工链一行未改、`assertBlackWhite` 未放宽。
- **CN 现行文本没有"不得着色"**：4.3 写的是"一般使用黑色墨水绘制，必要时可以提交彩色附图"。旧文献里的"不得着色和涂改"是 2010 版时代的转述——已在 `references/cn-drawing-rules.md` 记录，避免继续以旧说法当现行依据（渲染器仍按黑白构造，但那是产品选择）。
- **"actual size / scale ½ 不得出现"的落点是 PCT 指南 IP 5.150**（对 Rule 11.13(c) 的释义）+ 37 CFR 1.84(k)，**不是** PCT Rule 11.13(d)（该款只要求"比例须用图形表示"）。已在代码注释里显式警告，防止后按错条文改规则。

### 9.3 未做（沿用 §8 的边界，并补实施中确认项）

- `fit_to_page` 未在 `patentFigureCheck` 暴露（核验的是产物内容，与"是否另产落版页"无关）。
- 落版页未画 37 CFR 1.84(g) 的扫描定位十字（"should"级建议，超出本刀范围，已在 US 规则底座记为边界）。
- 未做端到端 DMG 构建验证（桌面端结论 = 配置事实 + 一次解包目录实测，已在 W0-3 的 note 里如实声明边界）。

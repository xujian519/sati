# 专利附图链路加固与 CAD 扩展实施方案

> 状态：**P0 全部 + P1 全部 + P2 阶段一已落地**（P0 见 PR #418；P1 见 #419；P2 见紧随其后的
> CAD 投影 PR）。实施中的两处对本计划的修正已回写：① §7 重录手册补「录制必须用重放测试 pin 的
> provider/model」；② §5.2 朝向对齐新增「参考体探测」实做（计划未涵盖 FreeCAD 投影坐标系朝向问题，
> 实测 front 视图会出 90° 旋转图）。阶段二（几何 DSL）按 D4 不做。
> 范围：`src/patent/figuregen/`、`src/patent/figure/`、`src/tool/builtin/patentFigure*.ts`、`src/patent/atoms/handlers/builtin/`（新增 gate）、`src/patent/workflow/manifests.ts`、新增 `src/patent/figuregen/cad/`
> 依据：对 `patent_figuregen` 现状的逐行核对与 `dist/` 实测（见 §11）；对照外部同类技能（Python/Graphviz 路线、CAD 隔离、像素级门禁缺失）后的取舍见 §10

---

## 0. 摘要

**现状**：附图的"契约 + 确定性渲染 + 规则核验"三件套已经建成（FigureSpec → 黑白 SVG → V1/V4/V5/V7/V8/V9；`data-ref` 可回读），但**核验器从未被自动调用**——`patent_drafting_v1` 的 `figure_generate` 是无原子透传阶段（`manifests.ts:470-478`），是否核验完全取决于主代理是否记得调工具。同时有两处"阈值/度量脱离出图介质"的缺陷、一处硬门禁假阳性、以及栅格/外部来源图零门禁。

**本方案要做的四件事**：① 把已有核验能力接成工作流门禁（P0）；② 把附图度量锚定到真实纸张（A4 可印区 + 毫米），修掉假阳性（P0）；③ 补齐"可确定性表达但当前缺失"的规则面与像素级门禁（P1）；④ 以本机 FreeCAD 为可选几何内核，补上当前完全空缺的"结构类附图生成"（P2，实测无头可用）。

**验收主线**：一份实用新型案跑完 `patent_drafting_v1`，附图阶段在**无人工提醒**的情况下产出 `figure-check.json` 留痕，且 V2/V4 级问题会阻断或挂 HITL；A4 打印稿中每幅图的物理尺寸与字高落在设定区间内。

### 0.1 已定决策（2026-09-17 评审）

| # | 决策点 | 结论 | 影响 |
|---|---|---|---|
| D1 | `figure-gate` 是否挂 HITL | **挂**（把 `figure-gate` 纳入 `isApprovalGateHandler`，fail 级走 `InterruptStageError`，可经 `approveStageIds` 放行） | 见 §3 P0-3；需补"兄弟门不静默放行"回归断言 |
| D2 | 像素门禁的接线方式 | **选干净替代**：`patent_figure_check` 新增可选属性 `image_paths`（不改 `svg_paths` 语义） | 改 `inputSchema` ⇒ **必须重录 fixture**（§7 手册）；P1-3 的 PR 内含此任务 |
| D3 | P1-1 的 spec 分面 | 先做**启发式分节切分**（零 schema 变更），显式 `claims_text`/`description_text` 参数延后，与 P2 工具暴露面同批 | 见 §4.1；V10/V11 先以启发式面生效 |
| D4 | P2 做到哪一步 | **只做阶段一**（已有 STEP/3D 源 → 直接投影）；阶段二（模型产几何 DSL）不做 | 见 §5.2；P2 新增工具暴露面 ⇒ 第二次重录（§7） |

> 全案重录**两次**：第一次随 P1-3（D2 的 `image_paths`）；第二次随 P2（D4 若以新工具暴露 CAD，此时把 D3 延后的 `claims_text`/`description_text` 一并加上，两次 schema 变更共用一次重录）。每次都是一次真实 API 调用即可完成——现有 fixture 只含 1 条记录（单轮问答），操作步骤见 §7。

---

## 1. 先读：必须遵守的仓库纪律

| # | 纪律 | 本方案的具体含义 |
|---|---|---|
| 1 | **llm-replay fixture 契约**（工具有 `inputSchema` 全量入请求键） | **默认零 schema 变更**：P0 全部、P1-1/P1-2/P1-4 走"扩展既有工具行为 + 落盘 sidecar"。已接受的两次 schema 变更（D2 `image_paths`、D4 CAD 工具暴露面）**各自 PR 内同批重录** `tests/fixtures/llm-replay/deepseek-v4-flash-basic/`；步骤见 §7 手册（录制为追加语义，必须先删旧 `records.jsonl`；`pnpm record:replay` 只校验不录制） |
| 2 | **生成物幂等快照** | 改 `manifests.ts` 必须跑 `pnpm gen:patent-workflow-docs` 更新 `assets/workflows/patent/generated/*.yaml`（`pnpm check:patent-workflow-docs` 会红） |
| 3 | **手册/YAML 引用存在性** | 新增原子名后过 `pnpm check:patent-sop`（`scripts/check-patent-sop-references.mjs`） |
| 4 | **隐藏清单纪律** | 评分线/阈值**不得**写进 `Atom.description` 与 manifest 阶段描述（worker 可见面）；数字只出现在 HITL 报告与本文档 |
| 5 | **决策记录** | 每个 PR 附一条 `docs/notes/implemented/` note，含 `## Alternatives considered`。**必须有**的四条：V7 语义变更（px→物理量）、V4 名称归一化、`figure-gate` 纳入 HITL（D1，含门粒度隔离论证）、`image_paths` 新增属性（D2，含"为何不用 svg_paths 语义扩展"）；P2 CAD 渲染器另附一条（参照 `2026-08-28-patent-figuregen.md` 的结构） |
| 6 | **边界** | `src/` 不得导入 `ui/`；patent 域不得依赖 `tool/` 层（`figuregen` 保持纯函数、无 I/O 决策） |
| 7 | **事件面** | 本方案不改 `AgentEvent`/gateway frames（门禁复用既有 `InterruptStageError` → 既有 HITL 链路），故无需 `gen:event-matrix`；若实施中引入新事件，必须 `pnpm gen:event-matrix` |
| 8 | **验证顺序** | `pnpm check` → `pnpm test`（`pnpm check` 不含 test）；提交走分支 + PR |
| 9 | **测试要求** | 改 `figuregen/` 必须附单测；LLM 回路走重放 seam，单测 mock 外部进程（FreeCAD/dot 走注入路径，不在单测里真跑） |

---

## 2. 变更地图

| 编号 | 变更 | 落点 | 契约影响 | 新增/改测试 | 前置 |
|---|---|---|---|---|---|
| P0-1 | V4 名称归一化（修假阳性） | `figuregen/check.ts:62` | 无 | `figuregen/check.spec.ts` | — |
| P0-2 | 附图 sidecar `*-figures.json` | `tool/builtin/patentFigureGenerate.ts` | 无（落盘产物，非 schema） | `figuregen/tools.spec.ts` | — |
| P0-3 | `figure-gate` 原子 + manifest 接线 | `atoms/handlers/builtin/gate.ts`（或新 `figure-gate.ts`）、`workflow/manifests.ts`、`generate/*.yaml` | 新增原子名（非工具 schema） | 新 `tests/patent/figure-gate.spec.ts`、`drafting-sop.spec.ts` | P0-2 |
| P0-4 | V7 介质锚定 + A4 版式约束 | `figuregen/check.ts:28`、`figuregen/html.ts` | 无 | `figuregen/check-p1.spec.ts`、`readback-html.spec.ts` | — |
| P1-1 | `spec_text` 启发式分节 + V10/V11（D3） | `figuregen/check.ts`、`tool/builtin/patentFigureCheck.ts` | 无（启发式切分，零 schema；显式参数延后，见 §4.1） | `check.spec.ts`、`tools-p1.spec.ts` | P0-4 |
| P1-2 | 字宽度量按字符类别 | `figuregen/layout.ts:36` | 无 | `figuregen/render.spec.ts`（快照需更新） | — |
| P1-3 | 像素级门禁（sharp）+ 新增可选属性 `image_paths`（D2） | 新 `figuregen/pixel-gate.ts`、`tool/builtin/patentFigureCheck.ts` | **改 `inputSchema` ⇒ 重录 fixture**（§7） | 新 `tests/patent/figuregen/pixel-gate.spec.ts` | P0-3 |
| P1-4 | 分析轨↔核验轨桥接 | `figure/analyze.ts`、`figure/multi-figure-consistency.ts`、`figure/validator.ts`、`tool/builtin/patentFigureCheck.ts` | 无 | `figure/*.spec.ts` | — |
| P2-1 | FreeCAD 能力探测 + 投影边表 | 新 `figuregen/cad/freecad.ts`、`scripts/…py` 模板 | 无（内部模块 + 环境变量，见 §5） | 新 `tests/patent/figuregen/cad.spec.ts` | — |
| P2-2 | CAD 渲染器接入 + 门禁 + 工具暴露面 | 新 `figuregen/cad/render-cad.ts`、`patentFigureGenerate.ts` | **新增工具/改 schema ⇒ 重录 fixture**（D4，§7） | 同上 + `cad-render.spec.ts` | P2-1, P0-4 |
| P2-3 | 几何 DSL（无条件延后） | 新 `figuregen/cad/geometry-dsl.ts` | — | — | P2-2 |
| P2-4 | 漂移清理 + 防回退断言 + 基准扩展 | 见 §6.2 | 无 | 见 §6.2 | P0/P1 |

---

## 3. P0：把已有能力接上线，并修掉两处会误伤的门禁

### P0-1 V4 名称归一化（修硬门禁假阳性）

**问题（实测）**：`stripRefMark`（`check.ts:62`）只剥离括号式标记。

```
stripRefMark("处理模块(20)") = "处理模块"
stripRefMark("处理模块20")   = "处理模块20"     ← 与上一行为不同名
```

同一组件在两张图上分别写 `处理模块(20)` / `处理模块20` → 判 **V4 fail**（附图不得定稿）。而本项目自有知识库卡片（`knowledge.db` doc `255359a2208c6957`）明确说明书正文惯例是"名称+数字、不加括号"，与 `patent-illustrator` SKILL 里"处理模块(20)"的 label 惯例相撞即误报。

**设计**：名称归一化为纯函数 `normalizeRefLabel(label)`：剥尾部 `（数字）`/`(数字)`/空白 + 尾部裸数字，再 `trim`；`V4` 比较改用它，`stripRefMark` 保留为对外形态（`brief.ts` 依赖其输出格式）。归一化只影响"比较"，不影响"呈现"。

**落点**：`src/patent/figuregen/check.ts`（新增导出 `normalizeRefLabel`，`check.ts:189-199` 的名称比较改用它）。

**测试**：`tests/patent/figuregen/check.spec.ts` 增表驱动用例（括号形/裸数字形/全角括号/带空白/多行 label 首行）＋**防回退断言**"标注格式差异不得触发 V4 fail"。

**验收**：上述构造用例 `ok === true`；`pnpm test` 原有 V4 用例（真冲突场景）仍 fail。

### P0-2 附图产物 sidecar（核验与留痕的输入契约）

**问题**：核验需要两样东西——**FigureSpec**（V1/V4/V5/V7/V8/V9）与**说明书文本**（V2/V3）。二者在时间上分离：生成时无文本（`patentFigureGenerate.ts:158-161` 以 `skipTextRules: true` 跑），定稿时有文本但要重新提供全部 spec。工作流阶段是透传的，agent 只能把路径写进阶段文本，下游无法结构化消费。

**设计**：`patent_figure_generate` 落盘一个 sidecar（与 SVG 同目录）：

```
<output_name>-figures.json
{
  "version": 1,
  "generated_at": "<ISO>",            // 审计用；不参与任何判定
  "jurisdiction": "cn",
  "document_kind": "utility",
  "renderer": "builtin",
  "figures": [ { "figure_no": 1, "path": "…-fig1.svg", "spec": { …FigureSpec… },
                 "check": { "ok": false, "findings": [ … ] } } ]
}
```

`spec` 完整落盘 ⇒ 下游在**有说明书文本时**可零信息损耗地重跑全部规则；`check` 是生成期结果（`skipTextRules` 语义），便于问题定位。

**落点**：`src/tool/builtin/patentFigureGenerate.ts`（写 SVG 的循环后追加一次写盘；`isReadOnly()` 不变，仍是写工具）。

**测试**：`figuregen/tools.spec.ts` 断言 sidecar 存在、`figures[].spec` 与入参等价、路径为相对/绝对的一致性、`version` 字段存在。

**风险**：sidecar 与 SVG 可能不同步（手工改 SVG）。缓解：`patent_figure_check` 用 sidecar 的 `spec` 判规则、用 `path` 指向的文件做 `data-ref` 回读，**两者不一致时 fail-loud**（回读结果与 spec 的 ref 集合比对，复用 `render-graphviz.ts:196-206` 的既有自检写法）。

### P0-3 `figure-gate` 原子 + 接线（本方案的核心）

**问题**：`figure_generate` 无原子（`manifests.ts:470-478`），`checkFigures` 只被两个工具调用 ⇒ 核验是可选的。

**设计**：新增确定性 gate 原子（与 `quality-gate`/`slop-gate` 同构）：

- `Atom`：`name: "figure-gate"`，`category: "gate"`，`inputSchema: ["figures_dir"]`（或空），`outputSchema: ["figure_report"]`；**description 只描述"审什么"（图号连续性、图文标记一致、画幅可印性），不出现数字**（隐藏清单纪律，对照 `gate.ts:104-108` 的写法）。
- `StageHandler.execute`：
  1. 定位附图：`state.figure_dir` → `resolve(process.cwd(), caseOutputsDir(state.caseId))` → `resolve(process.cwd(), ".sati/figures")`，取首个含 `*-figures.json` 的目录（三级回退各带原因串；全空 → `degraded`）。
  2. 读 sidecar（P0-2），`parseFigureSvg` 回读每个 SVG 做一致性自检。
  3. 文本面：`getStateString(state, "spec_draft")`、`claims_draft`（与 `slop-gate` 同键）。
  4. 调 `checkFigures(specs, text, { documentKind, jurisdiction })`。
  5. 产出 `figure_report`：通过/未通过 + 逐条 finding（rule/severity/message/evidence），并落盘 `figure-check.json` 到同目录（留痕，v1 契约：`{ version, checked_at, inputs_hash, result }`）。
  6. **fail 级** → `throw new InterruptStageError("figure-gate", …)` 挂 HITL（放行复用 `isApprovalGateHandler` 契约，见下）；**warn 级** → 报告透传不阻断。
- **接线**：`manifests.ts` 的 `figure_generate` 补 `atom: "figure-gate"`，并按需加 `retry`（`whenOutputMatches: "需修订"` → `rewindTo: "figure_generate"` 或 `"draft_spec"`，有界 1 次，证据型提示由 `retry-hints.ts` 风格构造器产出）。改完跑 `pnpm gen:patent-workflow-docs`。
- **HITL 语义（D1 已定：挂）**：把 `figure-gate` 加入 `isApprovalGateHandler`（`gate.ts:68-70`，当前只认 `approval-gate`/`clarity-gate`）。放行后经 `approveStageIds`（manifest 路径）/`grantApproval`（图路径）强制跨过，语义与 `clarity-gate` 的"人工强制放行"同构。**必须遵守既有"门粒度放行不泄漏"契约**（`executor.ts:64-71` 注释：执行态一律拷贝、放行标记只许 handler 局部可见，勿改），并同步补**"无 params 的已批准门不得放行后续兄弟门"**的回归断言（`drafting-sop.spec.ts` 已有同型先例）。放行后阶段输出用占位符（复用 `APPROVAL_GRANTED_OUTPUT`，避免被误标 degraded），并带"人工强制放行"标记。
- **`caseId` 可读性已核实（代码级）**：`const state: PipelineState = { ...ctx }`（`workflow.ts:158`），而 `WorkflowContext` 含 `caseId`（`patentWorkflowTool.ts:419`）⇒ gate 可经 `state.caseId` + `caseOutputsDir()` 定位附图目录，**无需新增状态键、无需改工具 schema**。
- **fixture 影响已核实为零**：`tests/fixtures/llm-replay/` 下只有 `deepseek-v4-flash-basic` 一个 fixture；drafting 全链路 fixture 未录制（`llm-replay-drafting.spec.ts` 在有 fixture 时自动生效、当前跳过）。manifest 阶段编排不参与请求键，故本项零重录。⚠️ 若将来录制 drafting fixture，**必须在 `figure-gate` 落地之后录**，否则新录的 fixture 会立即失配。

**测试**：新 `tests/patent/figure-gate.spec.ts`——(1) 无 sidecar → degraded 且报告说明原因；(2) sidecar + 干净文本 → 通过；(3) 图内标记未在文本出现 → fail + 挂 HITL；(4) 同一 ref 两名称（P0-1 归一化后）→ 不 fail；(5) `figure-check.json` 落盘且 `inputs_hash` 随输入变化；(6) **已批准的 `figure-gate` 不得放行后续兄弟审批门**（门粒度隔离）。另在 `tests/patent/drafting-sop.spec.ts` 加**接线防回退断言**（阶段声明了 `atom: "figure-gate"` 且阶段描述不含数字）。

**验收**：`patent_workflow_run(manifestId="patent_drafting_v1")` 跑到附图阶段时，无需人工提示即产出 `figure-check.json`；构造一处 V2 违规（图内 `ref` 未在 `spec_draft` 出现）时阶段中断并给出可放行的 HITL。

### P0-4 V7 改为介质锚定（A4 可印区 + 毫米）

**问题（实测）**：V7（`check.ts:28`，`FIGURE_CANVAS_MAX_PX = 1600`）用"画幅 px"代理"缩小到三分之二仍可辨"，但交付物是 A4 打印（`html.ts`：可印区 170×257mm，`max-width:100%` 只压宽不压高）。实测：

| 流程图步数 | 画幅 | 纸上尺寸 | V7 |
|---|---|---|---|
| 8 步 | 238×904u | 63×239mm | 通过 |
| 12 步 | 253×1340u | 67×**355mm** | **通过（漏报）** |
| 16 步 | 253×1776u | 67×470mm | 报 V7 |

9 步以上即超出可印页高（`109n + 32` px > 971px），会被分页切断而 V7 不响；且同一文档内字高在 1.49mm～3.7mm 间漂移（1600u 宽的图文字仅 1.49mm，缩 2/3 后 0.99mm）。

**设计**：把 V7 拆成两条基于**物理量**的发现（rule id 保留 `V7`，finding 带 `metric` 字段区分）：

1. **页高/页宽可印性**：`svg_mm = canvas_px / 96 * 25.4`（SVG `width`/`height` 无单位即 CSS px），与 A4 可印区（默认 170×257mm，常量与 `html.ts` 的 `@page` 边距同源导出，避免两处漂移）比较；超出 → **fail**（会被分页切断，属交付缺陷）。
2. **字高可辨性**：`printed_font_mm = min(1, 可印宽/canvas_mm宽) * FONT_SIZE / 96 * 25.4`，与"最小可辨字高"常量（初值 2.0mm，可配置）比较；低于阈值 → warn，并在 evidence 里报出实际 mm 与缩 2/3 后的 mm（把三分之二规则落到数字上）。

同时修 `html.ts`：`.figure-page svg { max-width:100%; max-height: <可印高>mm; }`、`.figure-page { break-inside: avoid; }`，并在多图时统一缩放系数（取所有图中最小缩放），使同文档字高一致。

**落点**：`figuregen/check.ts`（V7 逻辑 + 与 `html.ts` 共享的 A4 常量，建议提到新 `figuregen/page-contract.ts`）、`figuregen/html.ts`。

**测试**：`check-p1.spec.ts` 增表驱动（8/9/12/16 步 TB 流程图；宽图；正好卡边界）；`readback-html.spec.ts` 断言 `@page` 边距与 `max-height`/`break-inside` 存在且与常量一致。

**验收**：9 步及以上的 TB 流程图报 fail（附实际 mm），8 步通过；`pnpm test` 中 V7 既有用例按新语义更新（**这是语义变更，必须带决策记录**）。

---

## 4. P1：补齐可确定性表达的规则面与像素门禁

### P1-1 `spec_text` 分面 + V10/V11（括号规则）

**依据**（本项目知识库原文，`knowledge.db` doc `255359a2208c6957`）：细则第 22 条要求**权利要求**引用附图标记须置于括号内；**说明书正文**惯例为"名称+数字"不加括号。

**问题**：`patent_figure_check` 的 `spec_text` 是"权利要求书 + 说明书"混合体，`extractBracketRefs`（`check.ts:75`）对其整体扫括号 ⇒ 既漏掉"权利要求引用未加括号"这类可确定性判定的违规，也让 V3 只能保守 WARN。

**设计（D3 已定：先走启发式，零 schema）**：
- **本轮**：不新增入参。对既有 `spec_text` 按常见小节标题（`权利要求书`、`说明书`、`附图说明`、`具体实施方式`、`技术领域`）做**启发式分节**，得到 `claimsFace` / `descriptionFace`；切分不确定（找不到分界、多义标题）时**降级为现状**（整体扫）并在报告里注明"未分面，V10/V11 未生效"——不假装判定成功。
- **延后**：显式入参 `claims_text` / `description_text` 与 D4 的 CAD 工具暴露面**同批**处理（一次重录覆盖两处 schema 变更）。
- **V10**（fail，需分面成功）：`claimsFace` 中出现"组件名+裸数字"且该数字是图内标记 ⇒ 提示必须加括号。
- **V11**（warn，需分面成功）：`descriptionFace` 中以括号形式引用了图内标记 ⇒ 提示改"名称+数字"（排除公式编号 `式(1)`、步骤编号 `步骤(1)`、以及附图说明小节的"1—混料器"格式）。
- V3 在分面成功时按面判定（收窄保守 WARN）；未分面时维持现状。

**测试**：`check.spec.ts`/`check-p1.spec.ts` 表驱动（权利要求缺括号、说明书多括号、公式编号不误报、附图说明格式不误报、**分面失败时 V10/V11 静默不报且报告注明"未分面"**）。

### P1-2 字宽度量按字符类别

**问题（实测）**：`nodeSize`（`layout.ts:54-58`）用 `longest * CHAR_W (15)`。实测 `Data processing module`（22 字符）盒宽 362，而 6 字中文 122 ⇒ 英文标签盒宽约为实际渲染的 2.4 倍，US 模式画布虚胖（也推高 V7 触发概率）。

**设计**：`measureTextWidth(text, fontSize)`：CJK/全角按 `1.0em`、Latin/数字/半角标点按 `0.5em` 累计（`em` = `FONT_SIZE`），保留 `MIN_W` 下限。纯函数、无外部字体依赖（确定性不变）。可选精化：按字符类别查表（大写/小写/数字分别系数），但不引入字体文件。

**测试**：`render.spec.ts` 增"同字符数 CJK vs Latin 盒宽比 ≈ 2"的断言；快照用例按新宽度更新（**快照变更需在 note 中说明**）。

### P1-3 像素级门禁（栅格与外部来源图）

**问题**：`readback.ts:9-10` 自述"外部工具产出的 SVG 不在此契约内"，`patent_figure_check` 只吃 FigureSpec 或本模块 SVG ⇒ 客户扫描图、CAD 导出、他人绘制的图**零门禁**。本项目已依赖 `sharp`（`figure/preprocess.ts` 在用）⇒ 补齐成本低。

**设计**：新 `figuregen/pixel-gate.ts`（纯函数，输入 `Buffer` + 尺寸，输出 findings），检查项：
1. **黑白性**：非白像素的灰度分布 + 是否存在大面积中间灰（阴影/着色代理）；
2. **线宽**：非白像素的最小连通宽度估计（对二值图做行/列 run-length），低于阈值提示"线条过细，缩 2/3 后不可辨"；
3. **尺寸/DPI**：`sharp.metadata()` 的 `density`（DPI）与 `px / dpi * 25.4` 换算物理尺寸，校验 72–300 DPI 与 ≤170×257mm（与 P0-4 同一 `page-contract` 常量）；
4. **图号存在性**：栅格侧不做 OCR——改为"必须由 sidecar 或调用方声明图号"，无声明则报 warn（诚实降级，不假装能读像素）。

**接线（D2 已定：走干净替代）**：`patent_figure_check` **新增可选属性 `image_paths`**（图片路径数组），`svg_paths` 语义**保持不变**（仍只吃本模块 SVG 回读），sidecar 仍经 `svg_paths` 传入 `*-figures.json` 或（更明确地）新增 `figures_json` 亦可——两者都属 schema 变更，**在同一 PR 内一次做完**，避免两次重录。门禁分流：`svg_paths` → 回读（现状）；`image_paths` → 像素门禁（sharp 动态导入，缺失时 fail-explicit 提示安装，不静默跳过）。

**fixture 任务（本 PR 必做）**：改 `inputSchema` 后 `toolSchemaDigest` 变化，既有 fixture 失配 ⇒ **同批重录** `tests/fixtures/llm-replay/deepseek-v4-flash-basic/`，步骤见 §7；重录前的 PR CI 会红，属预期。

**工具 description 更新**：说明 `image_paths` 用于"非本工具产出的栅格/外部附图"的像素级合规核查（黑白、线宽、DPI、物理尺寸），并明示"不做 OCR，图号需调用方声明"。

### P1-4 分析轨↔核验轨桥接

**问题（实测）**：
- `checkFigureConsistency` 在 `src/` 内**无任何生产调用方**（只有 `figure/index.ts:74` 的 barrel 导出与测试）⇒ 多图一致性能力运行时不可达；
- 其 `missingRefs` 依赖 `extractClaimRefs`，实测对机械件号文本（`壳体(10)与盖板(20)通过螺栓(30)连接`）返回 `[]`（只认电学符号前缀）⇒ 即使接上，机械/实用新型案也基本空转。

**设计**：
1. `extractClaimRefs` 增"括号数字 + 名称直连数字"识别（与 P0-1 的归一化共用词法），保留"仅符号库前缀"作为高置信档；
2. `checkFigureConsistency` 接进 `patent_figure_check` 的多图路径（≥2 幅时自动跑，产出并入 `figure_report`）——**复用既有纯函数，不新增工具**；
3. 分析结果 → "无几何 FigureSpec 骨架"（`ref` + 名称，`edges: []`）供 `checkFigures` 复用 V2/V3/V4 ⇒ 客户提供的栅格图也能进文字面核验。

**测试**：`figure/multi-figure-consistency.spec.ts`（机械件号用例）、`figure/validator.spec.ts`（词法）、新桥接单测。

---

## 5. P2：FreeCAD 结构图渲染器（可选、fail-closed、毫米锚定）

### 5.1 实测结论（本机 FreeCAD 1.1.3，`freecadcmd` 无头）

| 能力 | 实测 |
|---|---|
| 无头运行 | `App.GuiUp = 0`；冷启动 **0.18–0.19s**（含 `import Part, TechDraw`） |
| 正投影 + 隐藏线 | `TechDraw.project(shape, dir)` → `[可见G0, 可见G1, 隐藏G0, 隐藏G1]`；带孔板正面 4 可见/9 隐藏 |
| 方向 | front/top/right/iso 均可参数化（无"四方向硬编码"问题） |
| 样式可控 | `projectToSVG(shape, dir, type, tol, vStyle, hStyle…)` 可直接传 `#000000` + 线宽 + 虚线 |
| 隐藏线开关 | `ShowHiddenLines` / `NoHiddenLines` 均可 |
| 确定性 | 同输入两次 sha256 一致 |
| 单位 | 输出数值即 **mm**（Y 由 `scale(1,-1)` 翻转） |
| STEP 往返 | 导出/导入各 6ms，几何一致 |
| 性能 | 20 孔板：建模 0.04s + 投影 1ms |
| 结构化导出 | 投影边可 JSON 化（`curve` 类型 + `discretize` 点） |
| 体积 | `/Applications/FreeCAD.app` **2.6GB** |

### 5.2 设计要点

- **能力探测 + 开关**：`SATI_FREECAD_CMD` 显式路径优先 → 其次探测 `Contents/Resources/bin/freecadcmd` → 均无则 fail-closed 报错（照抄 `resolveDotBinary` 的模式，`render-graphviz.ts:31-47`）。渲染器选择沿用 `SATI_FIGURE_RENDERER` 的值域扩展（`builtin|graphviz|cad`）——**环境变量而非 schema**，理由同 P3 决策记录（机器能力、零 fixture）。
- **数据流**：FreeCAD 侧脚本只输出 **JSON 边表**（`{kind: visible|hidden, curve, closed, points[]}`），SVG 由 Sati 自己的 `render-svg` 契约产出 ⇒ 黑白不变式、`data-ref`、A4 版式、readback **全部复用，不新增第二套交付契约**。
- **必须处理的四个坑**：① `freecadcmd` 会向 stdout 打版本横幅与 STEP 统计 ⇒ 解析必须从定界标记截取（`JSON_BEGIN/JSON_END` 或 `<svg`，同 `indexOf("<svg")` 先例）；② 默认样式是 `rgb(0, 0, 0)`，而 `assertBlackWhite`（`render-graphviz.ts:102-113`）只认 `none/#000000/#ffffff` ⇒ **要么显式传 `#000000`，要么扩展归一化器支持 `rgb()`（否则误杀）**；③ `project` 返回的孔边是 `BSplineCurve`（`projectToSVG` 才会输出 `<circle>`）⇒ 自有渲染器需按容差离散化或做近圆识别，否则圆变多边形；④ 无 GUI 只能用函数式 API，**不要走 `TechDraw::DrawPage` 文档对象**。
- **几何来源两阶段（D4 已定：只做阶段一）**：
  - **阶段一（本次做）**：已有 STEP/3D 源 → 导入投影。价值最高、风险最低（实测导出/导入各 6ms）。
  - **阶段二（不做）**：无 3D 源时由模型产"几何 DSL"（棱柱/回转体 + 布尔 + 圆角）→ 确定性编译为 FreeCAD 脚本。理由：模型直接产三维几何的可靠性不足；若未来要做，仍须坚持"编译而非让模型写 Python"（不可校验 + 注入面）。
- **门禁与留痕**：CAD 图同样进 `figure-gate`；新增几何级检查（边数>0、闭合性、最小可辨间距、视图方向白名单）；`figure-check.json` 记录 `renderer: "cad"` 与投影参数。
- **边界声明**：CAD 投影图**不得**用作外观设计图片；虚线隐藏线**默认关**（CNIPA 实务以剖视图表达内部结构），开关留在环境层；剖视图 = 用切平面 `common()` 后投影，剖面线另行确定性绘制且不得妨碍标记线（指南 4.3 原文明示）。

### 5.3 测试与验收

- 单测：能力探测（含缺失/版本不符 → fail-closed）、stdout 截取、`rgb()` 归一化、BSpline 离散化（容差）、`NoHiddenLines` 分支、几何级门禁阈值。
- **不在单测里真跑 FreeCAD**：走注入的 `runner` 接口 + 录制的 JSON 边表 fixture（与 dot 的注入先例一致）。
- 联调（手工，需本机 FreeCAD）：同一 STEP 出 front/top/right/iso 四图，检查线宽一致、无尺寸线/中心线、A4 页内不超框（承接 P0-4 的判据）。
- **fixture 任务（本 PR 必做，D4）**：CAD 渲染器若以新工具形式暴露给模型（推荐，与 `patent_figure_generate` 的 `renderer` 语义并列），工具集摘要变化 ⇒ 与 D3 延后的 `claims_text`/`description_text` 参数、D2 的 `image_paths` **合并为一次重录**（§7）。若 CAD 只经环境变量启用而零新增工具，则不触发重录——实施时优先确认这一点。

---

## 6. P2 收尾项

### 6.1 文档漂移清理（三处，实测）

| 位置 | 现状 | 应为 |
|---|---|---|
| `figure/types.ts:135`（与 `:158`） | `usable` 需"组件数 > 0 且置信度 ≥ 0.6" | 与 `analyze.ts:454-455` 一致："仅组件提取成功"（与分类置信度解耦） |
| `workflow/manifests.ts:475`、`skills/patent-illustrator/SKILL.md:77` | 两工具"opt-in 注册" | `createBuiltinRegistry.ts:366` 实际是**默认注册**（`patentFigure !== false`） |
| `figuregen/html.ts:4-5` | A4 边距"待与最终申请格式核对" | P0-4 落地后改为"与 `page-contract` 常量同源；边距为实践惯例，正式提交前由代理师按最终格式复核" |

### 6.2 防回退断言与评测扩展

- **防回退断言**（借鉴"脚本不得 import matplotlib"式测试）：① 标注格式差异不得触发 V4 fail；② 渲染器输出不得出现非黑白 token（扩展现有 V6 单测到 CAD 路径）；③ `figure_generate` 阶段声明了 gate 原子且阶段描述不含数字（隐藏清单）；④ `readback` 契约变更必须同批更新 fixture 清单（`pnpm record:replay` 门禁）。
- **评测扩展**：`scripts/figure-benchmark/`（现为分析侧，含 ref P/R/F1、类型准确率）增"生成侧合规基准"——用固定 FigureSpec 集合跑渲染 + 门禁，记录 V 规则命中数、A4 页内率、字高分布，作为 P0-4/P1-2 的回归护栏。

---

## 7. fixture 重录操作手册（全案共两次：P1-3 的 D2 一次；D3 延后参数与 D4 合并为第二次）

**触发条件**：任何会让模型可见的工具集合或某个工具 `inputSchema` 文本发生变化的改动（D2 新增 `image_paths`；D3 延后的 `claims_text`/`description_text`；D4 若以新工具暴露 CAD）。请求键 = 内容哈希 + `toolSchemaDigest`，`records.jsonl` **不持久化原始请求**，因此**无法离线重算键，只能重录**（`scripts/record-llm-replay.ts` 头部注释已明示"请勿手改 key"）。

**已核实的事实**（决定步骤顺序）：
- 现入库 fixture 只有 1 个（`deepseek-v4-flash-basic`，单轮问答："请用一句话介绍你自己…"），其 `manifest.json` 的 `toolNames` **已包含** `patent_figure_check` / `patent_figure_generate` ⇒ 这两个工具的 `inputSchema` 变更**必然**使该记录失配。
- 录制写入是**追加语义**（`record.ts:55` 用 `appendFile`）⇒ 重录前必须删掉旧 `records.jsonl`，否则两条记录并存、`index` 冲突。

**步骤**：

```sh
FIX=tests/fixtures/llm-replay/deepseek-v4-flash-basic

# 0) 先确认新工具集/新 schema 下测试确实红了（预期失败，证明重录必要）
pnpm build && node --test dist/tests/test-support/llm-replay-real.spec.js

# 1) 清旧记录（追加语义，不删会重复）
rm "$FIX/records.jsonl"

# 2) 真实录制（需 ~/.sati/sati.yaml 内配置可用的 provider key；任务文本与原 fixture 保持一致）
#    ⚠️ 必须用重放测试 pin 的 provider/model（tests/test-support/llm-replay-real.spec.ts 的
#    makeConfig：provider=deepseek, model=deepseek-v4-flash）——录制脚本默认取本机
#    ~/.sati/sati.yaml 的 agent.model，本机若已切到别的模型（如 deepseek-flash），
#    录出的请求键与重放侧不一致（实为 NO_REPLAY_RECORD 失配）。用 PILOT_AGENT_MODEL 对齐：
PILOT_AGENT_MODEL=deepseek/deepseek-v4-flash \
  SATI_LLM_REPLAY_RECORD_ROOT="$FIX" \
  node --import tsx scripts/record-real-fixture.ts "请用一句话介绍你自己，以及你能为专利工程师提供哪些帮助。"

# 3) 校验 fixture 结构与可驱动性
pnpm record:replay "$FIX"

# 4) 重放测试必须转绿
pnpm build && node --test dist/tests/test-support/llm-replay-real.spec.js
pnpm test
```

**注意事项**：
- 录制装配必须与 `tests/test-support/llm-replay-real.spec.ts` 一致（`record-real-fixture.ts` 已对齐：内置注册表 + `enabled:false` router + 同一 env hooks）⇒ **不要**在录制期间临时改注册表开关，否则录出的 `toolNames` 与测试装配不符，会再次失配。
- **provider/model 也必须一致**（2026-09-17 实操修正）：录制脚本取本机 `~/.sati/sati.yaml` 的 `agent.model`，而重放测试 `makeConfig` 固定 `deepseek/deepseek-v4-flash`——**两者一致是请求键成立的前提**。用 `PILOT_AGENT_MODEL=<provider>/<model>` 对齐后再录（步骤 2 已含）。
- 录制产物不得含 API key（走 `~/.sati/sati.yaml`，仓库外）；提交前 `git diff` 目视确认 fixture 只含 `manifest.json` + `records.jsonl`。
- CI 无 key，故**重录必须在本地完成并随 PR 提交**；评审时对照 `manifest.json` 的 `toolNames` 是否新增了预期工具。

---

## 8. 验收总表

```sh
pnpm check                                  # 聚合门禁（lint 末尾挂 8 个领域门禁）
pnpm gen:patent-workflow-docs               # 改了 manifests.ts 必须跑
pnpm test                                   # build + node --test dist/tests
node --test dist/tests/patent/figuregen/*.js dist/tests/patent/figure-gate.spec.js   # 窄面快跑
```

| 项 | 判据 |
|---|---|
| P0-1 | 括号/裸数字格式差异不再触发 V4 fail；真冲突仍 fail |
| P0-2 | sidecar 落盘且 `spec` 可无损重放全部规则；与 SVG 不一致时 fail-loud |
| P0-3 | 走到附图阶段（无人工提示）即产 `figure-check.json`；V2 违规中断并可放行 |
| P0-4 | ≥9 步 TB 流程图报 fail 并给 mm；A4 稿各图字高一致且在阈值内 |
| P1-1 | V10 命中"权利要求漏括号"、V11 不误伤 `式(1)`/`步骤(1)`/`1—混料器` |
| P1-2 | 同字符数 CJK/Latin 盒宽比 ≈ 2；US 模式画布不再虚胖 |
| P1-3 | 经 `image_paths` 传入的灰度着色图、过细线、DPI 越界、物理尺寸超框各报一条对应 finding；`svg_paths` 行为不变（回归） |
| P1-4 | 机械案多图一致性报告非空；`checkFigureConsistency` 有生产调用方 |
| P2 | 无 FreeCAD 时 fail-closed 不静默回退；有 FreeCAD 时四视图出图并与 A4 判据一致 |
| D2/D4 | `pnpm record:replay tests/fixtures/llm-replay/deepseek-v4-flash-basic` 通过，`llm-replay-real.spec` 重放绿，且 `manifest.json` 的 `toolNames`/schema 变更与代码一致（§7） |

---

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| V7 语义变更（px → 物理量）打破既有用例与用户预期 | 中 | 独立 PR + 决策记录；finding 带 `metric` 区分"超页"与"字高"；阈值可配置 |
| 已接受的两次 schema 变更（D2 `image_paths`、D4 CAD 工具）需真实 API 重录 fixture | 中 | 操作手册 §7（含"追加语义须先删旧 records.jsonl"）；D3 延后参数与 D4 合并成一次，把总次数从 3 降到 2；每个改动方 PR 内自带重录，避免 CI 长期红 |
| `figure-gate` 挂 HITL 后 `isApprovalGateHandler` 扩容 | 中 | 沿用"门粒度放行、只注入 handler 局部执行态"契约（`executor.ts:64-71` 注释明确勿改），并加"sibling 门不静默放行"回归断言（`drafting-sop.spec.ts` 已有先例） |
| sidecar 与 SVG 漂移 | 中 | 回读自检 + fail-loud（见 P0-2） |
| FreeCAD 版本/API 漂移（`projectToSVG` 旧版可能缺失） | 中 | 启动能力探测 + fail-closed；JSON 边表路径不依赖 `projectToSVG` |
| FreeCAD 2.6GB 依赖 | 低 | 不捆绑分发、本机可选、`SATI_FREECAD_CMD` 显式路径（同 graphviz 先例） |
| 隐藏清单纪律被破坏（阈值写进阶段描述） | 中 | P0-3 与 6.2 各带一条防回退断言 |
| 隐藏清单纪律被破坏（阈值写进阶段描述） | 中 | P0-3 与 6.2 各带一条防回退断言 |

---

## 10. 明确不做 / 延后（边界诚实）

- **外观设计图片类附图**（Sati 现状即声明未做）：外观要的是图片/照片与另一套像素规则（阴影、虚线、渲染），CAD 线图不能顺手复用；若要立，须先核验官方文本再立规则。
- **几何 DSL 自动建模**（P2 阶段二）：模型直接产 3D 几何的可靠性不足，先只支持"客户/己方已有 STEP"。
- **栅格图 OCR 读图号**（P1-3）：不在本轮引入 OCR 依赖；改为"必须有声明，无声明诚实降级"。
- **未核验的规则**：审查指南 4.3 是否含"横向布置时图顶朝左""图幅与页边距具体数值"等条款——本地 `knowledge.db` 无该节原文，**未核验即不写成规则**；如需补，先拉官方公布文本核对后再进 `cn-drawing-rules.md`。

---

## 11. 附录：实测数据与复现

```sh
# 阈值/度量与介质脱钩（P0-4）
node /tmp/figprobe2.mjs      # 4/8/12/16 步 TB 流程图 → 纸上 mm 与 V7 命中
# V4 假阳性（P0-1）
node /tmp/figprobe4.mjs      # stripRefMark 形态差异 → V4 fail
# 字宽度量（P1-2）
node /tmp/figprobe.mjs       # latin 362 vs cjk 122 盒宽
# 机械件号词法空转（P1-4）
node /tmp/figprobe3.mjs      # extractClaimRefs("壳体(10)…") = []
# FreeCAD 能力（P2）
/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd /tmp/fc_proj2.py    # 投影/样式/确定性
/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd /tmp/fc_views.py    # 四视图/隐藏线开关/STEP/耗时
```

（脚本为本次核查的一次性探针，未入库；实施时应把其中关键断言固化为单测，探针本身不提交。）

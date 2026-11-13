# Agent Note: 附图对齐 deepseek-harness 批次 C（CAD 结构线稿深度）

Status: implemented

## Problem

批次 C 要在**零 `inputSchema` 变更**（AGENTS.md 第 6 条：本机无 provider 凭据，无法重录
llm-replay fixture）的前提下，给 CAD 结构线稿补三项能力：

1. **每零件几何事实 + 件号锚点自动选取与核对** —— 此前 `patent_figure_project` 只投影整模，
   不知道"模型里有几个零件、件号落在哪个零件上"；锚点由调用方给，工具**不核对**它是否
   真在零件上（DSH 的 `verify_callout_owners` 会核对，容差 0.5mm）。
2. **多视图一次产出 + manifest** —— 此前一次调用只出一个视图；要三视图就得跑三次
   FreeCAD（三次进程、三份不一致风险、三倍耗时）。
3. **剖面线方向交替** —— 此前 `hatchPolylines` 是固定 45° 扫描线，相邻零件的剖面线**同向**，
   图面上相邻材料区域糊成一片（GB/T 4457.5 要求相邻零件的剖面线方向或间距不同）。

对照实现（DSH `packages/patent/patent-tools/src/figure/`）：`freecad-structure-script.ts`
（多视图 + 件号锚点自动选取 + 按零件真实几何核对）、`freecad-hatch-geometry.ts`
（剖面线方向 forward/backward）、`tool/structure-types.ts`（`modelPaths` 顺序即件号归属口径）。

## Decision

### C-0 载荷升版：投影产物 v3（多视图 + 零件事实 + 锚点归属）

- `freecad.ts` 的 `parseProjectionOutput` 拆成两层：**逐视图校验只有一份**
  （`parseEdgeTable`），`parseProjectionPayload` 负责顶层（v3）与历史 v2 的兼容读法，
  `parseProjectionOutput` 取主视图（既有调用方不改）。
- **v2 仍然可解析**（历史单视图平铺载荷）⇒ 既有录制夹具
  （`tests/fixtures/patent/cad/*.json`）与旧产物不失效；v2 的零件与锚点为空
  （**如实留空，不编造**）。
- 脚本生成器从 `freecad.ts` 拆到 `cad/freecad-script.ts`（纯函数、无 IO ⇒ 可在无 FreeCAD
  的环境单测）；失败标记常量落到 `cad/error-marker.ts`（生成侧与消费侧共用单点事实源，
  避免两个模块互相 import 成环）。

### C-1 锚点：测量在 FreeCAD 侧、口径在 TS 侧

- **测量**（FreeCAD 侧脚本）：逐 solid 出包围盒 / 质心 / 面积 / 体积；逐视图出该零件的
  **投影包围盒**与**建议锚点**（表面采样点中投影离轮廓中心最远者 ⇒ 其投影恰在轮廓边界）；
  显式锚点的**归属**按"先表面（≤0.5mm）、再包围盒"判定。
  ⚠️ 实测坑：`solid.distToShape(vertex)` 对**实体内部**的点返回 0（"在实体内"的语义），
  故"到表面的距离"必须问**壳体**（`solid.Shells[0].distToShape`）。
- **口径**（TS 侧 `cad/anchors.ts`）：显式锚点优先；未被显式覆盖的零件**按零件顺序**自动
  补件号（件号取未被占用的最小正整数，确定性）；归属与锚点坐标写进
  **manifest**（件号 → 零件序号 → 锚点坐标）。
- **判据**：`C14 anchor-not-on-part`（锚点不落在任何零件上 ⇒ warn，不静默画一条指错零件
  的引线）、`C15 anchor-inside-part-outline`（锚点投影落在其零件轮廓内部 >0.5mm ⇒ warn，
  引线会横穿零件面）。两者**在出图前**判（C14/C15 只依赖测量，不依赖排版）⇒ 引线择位
  失败时也不会丢掉锚点问题。
- **不适用时如实声明**：模型**没有 solid** ⇒ "零件口径不适用"（既不判通过，也不误报
  C14）；模型**只有 1 个 solid** ⇒ "归属无歧义（按唯一零件记录）"，多零件归属核对不适用。
- **自动件号默认关闭**（部署级 env `SATI_CAD_AUTO_ANCHORS=1` 开启）：既有语义是"只标注
  调用方给的锚点"，默认打开会给没要求标注的图凭空加件号 ⇒ 属行为变更，改为显式开关。

### C-2 多视图：一次 FreeCAD 运行产出全部视图 + manifest

- 部署级 env `SATI_CAD_VIEWS=front,top,right`（逗号分隔）；**`view` 入参仍是主视图**
  （优先、去重、保序）；env 未设置 ⇒ 维持现状的单视图行为。
- 脚本在**一次进程**里循环投影全部视图（`for VIEW, DIRECTION in VIEW_LIST`）⇒ 性能与
  一致性都优于"每视图一个进程"。
- 产物：每个视图一张 SVG（多视图时文件名带 `-<view>` 后缀，单视图沿用旧名）+ 一份
  **manifest**（`cad/structure-manifest.ts`：视图 → 文件 → 几何事实 / 件号归属）。
  sidecar 的契约是"一幅图一个文件条目"（`figures[].figure_no` 唯一）⇒ sidecar 记主视图，
  其余视图由 manifest 承载（两者互补，不改 sidecar 既有语义）。

### C-3 剖面线方向交替

- `hatchPolylines` 的方向角**可参数化**（默认 45°，与既有产物逐字节一致）；
- 相邻关系用现有几何信息判定：剖切面按**投影质心**（先 x 后 y）排序 ⇒ 依次 45°/135°
  交替（GB/T 4457.5 的"方向相反"那一支）；`C16` 报出各剖切面的实际方向。

### C-4 交付链收尾（主代理补做，两项）

1. **时序门真正生效**：清单契约增**输入件时刻**（sidecar 的可选字段 `deliverableInputs`），
   核验侧把它喂给 `checkDeliverableManifest` ⇒ 「渲染件晚于输入件」可判。
   CAD 通路**有文件型输入**（模型 STEP）⇒ 装配时登记模型的落盘时刻，时序门在 CAD 交付上
   **真的执行**；生成通路（FigureSpec 是模型在内存里给的）无文件型输入 ⇒ 不登记 ⇒
   核验侧如实声明「时序门本次未执行」，**不假装通过**。
   （sidecar 字段 ⇒ **零 `inputSchema` 变更**，不影响 llm-replay fixture。）
2. **交付复核与结构侧的重复发现去重**：同一处英文 label 在两条通路上都会命中 V13
   （结构侧按规则聚合成一条 + 多行证据；交付侧逐命中列一条）⇒ 同一缺陷在报告里出现两次。
   去重口径：**同规则号 + 被「」引起来的命中片段**已被结构侧报过 ⇒ 交付侧不重复报；
   引不出片段的发现（DR 族、清单族）一律保留。**只压重复，不改级别、不删新缺陷。**

## Alternatives considered

- **改 `inputSchema` 加 `annotations[].part_index` / `views` 字段** —— 否决：`inputSchema`
  任一改动（含描述文本）都会改 llm-replay 的 `toolSchemaDigest` ⇒ 既有 fixture 失配 ⇒
  必须重录，而本机无 provider 凭据（批次 B 已实测：改一个词即打红重放门禁）。
- **件号归属由调用方用下标显式声明（DSH 的 `callouts[].model`）** —— 否决：同上，改不了
  入参。改用**几何判定**：锚点落在哪个零件上就归属哪个零件，并把判定结果写进 manifest，
  让下游不必猜。代价是"调用方本意"与"几何判定"可能不一致 —— 故归属结果**显式可查**
  （manifest 的 `callouts[].partIndex`），不藏起来。
- **自动件号默认开启** —— 否决：既有语义是"只标注调用方给的锚点"；默认开启会给没要求
  标注的图凭空加件号（行为变更）。改为 env 显式开启。
- **建议锚点取"严格在零件投影包围盒之外"的点** —— **几何上不可兼得**：落在零件**表面**上的
  点，其投影必然落在该零件的投影轮廓之内（轮廓即表面投影的并集）。实现取：
  表面采样点中投影离轮廓中心最远者（其投影恰在包围盒**边界**），再沿包围盒外法向**外推
  0.05mm**（`CAD_ANCHOR_OUTSET_MM`）⇒ 投影严格在包围盒之外，而它到表面的距离仍是
  0.05mm < 容差 0.5mm ⇒ "落在该零件表面上"按容差口径成立。外推被**夹回已绘制几何范围**
  （最外层零件处"零件轮廓之外"与"图面之内"不可兼得 ⇒ 取图面之内的一侧；否则引线起点跑到
  图外，还会误触 C8）。
- **剖面线用 FreeCAD 的 `.pat` 图案文件（DSH 的做法）** —— 否决：DSH 那条路要引入
  `.pat` 资产生命周期与角度回填校验；本仓的剖面线是**自绘扫描线**（纸面毫米、确定性、
  黑白不变式），把方向角参数化即可满足"相邻可区分"，不必换内核。
- **多视图各自跑一个 FreeCAD 进程** —— 否决：性能（三倍冷启动）与一致性（同模型两次投影
  的坐标漂移）都更差；DSH 也是一次进程多视图。
- **manifest 写进 sidecar（改 `sidecar.ts` 的 `FigureSidecarGeometry`）** —— 否决：
  `sidecar.ts` 不在本批的可写归属清单内；且 sidecar 契约是"一幅图一个文件条目"，多视图塞
  不进去。改为独立 manifest 文件（sidecar 记主视图，manifest 记全部视图）。
- **把编排与产物装配留在工具层** —— 否决：`patentFigureProject.ts` 原本 747 行（上限 800），
  多视图循环 + 逐视图产物会让它超限。改为 `cad/project.ts`（编排）+ `cad/artifacts.ts`
  （落盘），工具层只留 env 解析与调用（现 707 行）。
- **`patentFigureCheck.ts` 的 800 行超限（批次 A/B0 的未提交改动把它从 509 行推到 804 行）
  登记进架构基线豁免** —— 否决：基线是**存量**豁免清单，把本轮工作树里"长大"的文件登记成
  存量 = 承认一笔新债。改为**纯搬迁**：报告文本构建（`quotedFragments` /
  `dedupeDeliveryFindings` / `buildCheckReportLines` + 三个报告面条目类型）整块搬到新模块
  `src/tool/builtin/patentFigureCheckReport.ts`（**不改行为**），主文件回到 570 行。
  （这与同族先例一致：`patentFigureReport.ts` 为 `patent_figure_generate` 做同一件事。）

## Consequences

- 三项能力**全部生产可达**，且**零 `inputSchema` 变更、零新增 builtin 工具** ⇒
  llm-replay fixture 无需重录。
- 新增 7 个模块（`cad/freecad-script.ts` / `error-marker.ts` / `anchors.ts` / `views.ts` /
  `structure-manifest.ts` / `project.ts` / `artifacts.ts`）+ 1 个体量拆分模块
  （`src/tool/builtin/patentFigureCheckReport.ts`，把 `patentFigureCheck.ts` 从 804 行
  拉回 570 行）⇒ `docs/code-facts.md` 的 `src/patent/` 文件数基线与
  `docs/technical-debt/metrics.md` 变化，已跑 `pnpm gen:doc-claims` 与 `pnpm measure:update`。
- **行为变化（须知悉）**：
  - 报告文本措辞变了（"已投影 N 个视图" + 逐视图分段），既有断言已同步更新；
  - 工具的 `outputSchema` **新增** `svg_paths` / `manifest_path` 两个**可选**字段
    （`outputSchema` 不参与重放请求键，改它不影响 fixture）；
  - 模型只有 1 个 solid 时，报告会多一句"件号归属无歧义（多零件归属核对不适用）"；
  - 锚点确实不在任何零件上时，报告会多一条 `C14` warn（此前无此判据）。
- **未做 / 降级**（诚实记账）：
  - **局部放大视图**（DSH 的 `TechDraw::DrawViewDetail`）未做：需要"窗口圆心 + 半径"的
    入参来源（零入参变更下没有来源），且 TechDraw 的 DrawViewPart/DrawPage 文档对象在
    本机无头环境不可靠。可行接入形态：将来重录窗口开 `details[]` 入参，或先做
    "env 提供窗口参数"的过渡形态（与 `SATI_CAD_VIEWS` 同族）。
  - **分解图**（exploded view）未做：需要装配轴语义（入参/env 都还没有）。
  - **旋转剖 / 阶梯剖 / 局部剖**未做（沿用既有边界声明）。
  - **多视图的落版页拼版**未做：`fit_to_page` 只对主视图出一张整页；多视图整页拼版是版式
    问题，不是投影问题。

## Verification

- `pnpm exec tsc --noEmit`：零错误；`pnpm build`：通过。
- `pnpm exec eslint <改动文件>` / `pnpm exec biome check <改动文件>`：干净。
- `node --test dist/tests/patent/figuregen/*.spec.js`：519 例，518 通过、1 skip（既有 skip）、
  0 失败；`node --test dist/tests/**/*.spec.js`：2422 例，2421 通过、1 skip、0 失败。
- 新增用例 `tests/patent/figuregen/cad-batch-c.spec.ts`（23 例：视图计划 / v3 载荷 /
  一次运行多视图 / 归属与自动锚点 / C14 / C15 / 剖面线方向 / manifest / 真机 3 例）。
- **真机探针**（本机 FreeCAD 1.1.3，`/Applications/FreeCAD.app/Contents/Resources/bin/
  freecadcmd`；脚本与输出见本次交付记录）：2 个 solid 的模型 ⇒ 一次运行产出 front/top/right
  三视图、2 份零件事实（体积 12000 / 10000、面积 3800 / 2800）、件号 10→零件 0（显式）
  与件号 1→零件 1（自动、外推已施加）、不落零件的锚点报 C14、同一剖切面上的两个材料区域
  剖面线方向 [45°, 135°]（SVG 里实测 14 段 45° + 14 段 135°）。
- **依赖 FreeCAD 的用例在缺 FreeCAD 的环境自动 skip —— 跳过表示「无信号」，不是「通过」**
  （AGENTS.md 第 11 条）：CI 未装 FreeCAD ⇒ 真机链路在 CI 上没有信号，靠本地真机跑补。

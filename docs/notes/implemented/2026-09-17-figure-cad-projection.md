# Agent Note: CAD 结构图投影（FreeCAD 无头，阶段一：STEP → 黑白 SVG）

Status: implemented

## Problem

本模块此前只能画**结构化示意图**（流程图/框图，由 `FigureSpec` 布局）。结构类附图
（机械/实用新型的零件图）在 Sati 完全空缺：要么让模型"画"（不可靠），要么客户/己方有
3D 源却用不上。而结构图恰恰是最需要**真投影**（正交视图 + 隐藏线）而非示意画法的图。

本机实测（FreeCAD 1.1.3，`freecadcmd`，`App.GuiUp = 0`）：冷启动 0.18–0.19s；
`TechDraw.project(shape, dir)` 返回 `[可见 G0, 可见 G1, 隐藏 G0, 隐藏 G1]`；输出数值即毫米；
同输入两次 sha256 一致；STEP 导出/导入各 6ms。四类坑也已实测：stdout 混有版本横幅；
默认样式是 `rgb(0, 0, 0)`（会被本模块黑白不变式误杀）；孔边是 `BSplineCurve` 而非 `Circle`；
无 GUI 不能用 `TechDraw::DrawPage` 文档对象。**投影坐标系由 TechDraw 自选**（front 视图里
u 对应 −Z，不是"u 就是 X"）。

## Decision

新增 `figuregen/cad/`（阶段一：**已有 STEP → 直接投影**）与工具 `patent_figure_project`：

1. **数据流分两段**：FreeCAD 脚本只输出 **JSON 边表**（可见/隐藏 + 离散化折线点，定界标记
   包裹），SVG 由本模块的渲染契约产出 ⇒ 黑白不变式、图号标注、A4 版式、回读全部复用，
   不新增第二套"谁来画"的实现（`projectToSVG` 的 `rgb()` 默认样式问题也不复存在）。
2. **朝向对齐用参考体探测**（本次实做新增，计划未涵盖）：脚本另投影三个单位立方体，得到
   模型 X/Y/Z 轴在投影平面上的像（`axes`）；渲染侧按视图定义"屏幕右轴/上轴"，用点积把 (u,v)
   映射为屏幕坐标 —— `front` 视图因此得到"40mm 宽 × 10mm 高"的直立正投影，而不是 FreeCAD
   原始坐标系的 90° 旋转图。对齐是**纯函数**（`buildScreenTransform`），可用录制的边表单测。
3. **交付契约复用**：SVG 适配 A4 可印区（`scale = min(1, 可印区/几何)`），线宽 0.35mm，
   隐藏线**默认关**（CNIPA 实务以剖视图表达内部结构，虚线易与标记线混淆）。
4. **几何级检查 `C1–C4`**（与 `V*`/`PX*` 分列）：边数为 0 → fail（出图前拦截）；退化短边、
   缩放过低 → warn；绘隐藏线 → info。**明确不做**"最小线间距"（需先重建轮廓，相邻边共享
   端点使逐点距离必为 0）。
5. **能力探测 fail-closed**：`SATI_FREECAD_CMD` → 常见安装路径 → 均无即报错，**不静默回退**
   内置渲染器（CAD 图只能由几何投影得到）。
6. **sidecar 记几何来源**：`figures[].geometry = { source:"cad", view, scale, width_mm, height_mm,
   hidden_lines, findings }`；附图门把它连同 `renderer` 写进 `figure-check.json`（投影参数可审计）。
7. **fixture 同步**：新增工具 + `patent_figure_check` 新增 `claims_text`/`description_text`
   （D3 延后项，按计划与 CAD 暴露面合并，**一次重录覆盖两处 schema 变更**）。

## Alternatives considered

- **直接用 FreeCAD 的 `TechDraw.projectToSVG` 出图** — 落选：那是第二套交付契约（颜色/线宽/
  版式/图号/data-ref 都要重新归一化，且默认 `rgb(0, 0, 0)` 会被黑白不变式误杀）。边表 → 自有
  渲染器的路径让 CAD 图与内置图共享全部下游能力（门禁、回读、A4 版式）。
- **接受 FreeCAD 的投影坐标系原样（不做朝向对齐）** — 落选：实测 front 视图会得到 90° 旋转
  图（模型的 X 变成竖直方向），对交付是明显缺陷；参考体探测的成本是 3 次投影（各 <1ms）。
- **在 Python 侧做归一化/变换** — 落选：变换是纯几何，放 TS 侧就能用录制的边表**在单测里
  验证朝向**（Python 侧只能靠真跑 FreeCAD 才能测）。
- **用 `ProjectionGroup`/`DrawViewPart` 文档对象** — 落选：无 GUI 环境不可用（实测），
  且引入文档生命周期管理；函数式 `TechDraw.project` 已足够。
- **让 CAD 图也走 V 规则画幅判定（V7）** — 落选：CAD 图的画幅由投影几何与适配缩放决定，
  用 `layoutFigure` 的空骨架去算 V7 是错误归因（骨架 15×25mm 恒过，属"永远通过"的假保证）。
  改为: CAD 的页内适配由 `render-cad` **构造性保证**（并报告缩放系数），几何级检查覆盖
  "边数/退化边/缩放"三项；`figure-check.json` 记录投影参数供审计。
- **阶段二（模型产几何 DSL → 编译为 FreeCAD 脚本）** — 明确不做（D4）：模型直接产三维几何
  可靠性不足；若将来要做，仍须"编译而非让模型写 Python"（不可校验 + 注入面）。
- **把 CAD 图作为 `SATI_FIGURE_RENDERER` 的新取值（零 schema 变更）** — 落选：CAD 的输入是
  **STEP 文件 + 视图方向**，而 `FigureSpec` 里没有也不该有这两样（它是示意图契约）；硬塞
  renderer 取值会让"渲染器"参数语义塌掉。故以新工具暴露（代价是 fixture 重录一次，已与
  D3 的 `claims_text`/`description_text` 合并为同一批）。

## Consequences

**换来**：结构类附图首次有确定性出图路径（真投影 + 隐藏线 + 毫米锚定 + A4 适配）；
朝向对齐、边表解析、几何检查全部可在无 FreeCAD 的 CI 里测（录制边表 fixture）。

**付出**：

- **依赖本机 FreeCAD（2.6GB）**：不捆绑、不在 CI 里跑真机（单测走注入 runner）；缺装则
  `patent_figure_project` 直接失败（fail-closed，这是有意的）。
- **视图配置（第一角/第三角）不声称遵循**：本模块只保证"正交投影 + 模型竖直轴在图上竖直"，
  纸面配置（哪一视图放哪里）属交付排版约定，需代理师按最终格式复核（同"未核验的规则不写成
  规则"纪律）。
- **本图是未标注投影图**：附图标记的图面位置需要坐标系统，属后续能力；当前工具只保证投影图
  本身合规，`spec.nodes` 为空骨架。→ **2026-09-17 已补齐**（见下方"相关"）。
- **不做剖面线/剖视图**：需切平面 + 确定性剖面线绘制（指南 4.3 要求不妨碍标记线）。→
  **2026-09-17 已补齐**（见下方"相关"）。
- fixture 因新增工具再次重录（工具集 46 → 47），重放测试的请求键随之刷新。
- 边数上限 20,000：超大装配投影既不可辨也不可审，超出即 fail-closed。

## 相关

- 计划：`docs/patent-figure-hardening-plan.md` §5（P2 阶段一）
- 后续补齐（同一模块）：`docs/notes/implemented/2026-09-17-figure-cad-section-and-numerals.md`
  （剖视图与剖面线、附图标记标注、边表 v1 → v2 的 `axes.origin`）
- 实测数据：同计划 §5.1 与 §11（本机 FreeCAD 1.1.3 探测/投影/确定性）
- 代码：`src/patent/figuregen/cad/`（types/freecad/render-cad/checks）、`src/tool/builtin/patentFigureProject.ts`
- 测试：`tests/patent/figuregen/cad.spec.ts`（模块）、`tests/patent/figuregen/cad-tool.spec.ts`（工具 + 附图门接线）、
  fixture `tests/fixtures/patent/cad/`（重录脚本 `scripts/record-cad-fixtures.ts`）

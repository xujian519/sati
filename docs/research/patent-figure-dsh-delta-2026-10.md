# 专利制图工具：deepseek-harness 与本项目差异分析

> 调研日期：2026-10-01
> 对照仓：`/Users/xujian/projects/deepseek-harness`（`packages/patent/patent-tools`）
> 本仓：`src/patent/figure/`、`src/patent/figuregen/`、`src/tool/builtin/patentFigure*.ts`、`src/patent/atoms/handlers/builtin/figure.ts`
> 方法：两侧源码逐模块阅读 + 决策记录（`.agents/notes/`、`openspec/specs/`）+ git 时间线对齐；结论均带路径证据。

---

## 0. 结论摘要

1. **本仓在合规闭环与工作流门禁上仍然领先**：`figure-gate` 工作流门禁、sidecar 漂移检测、V1–V21 规则 + 逐法域档案（数值逐条核验、不照抄）、`pixel-gate` 栅格门禁——这四件 DSH 都没有。本轮不讨论回退。
2. **本仓的 `docs/patent-figure-harness-parity-plan.md`（2026-09-22，已实施）已把当时的 DSH 差集补齐**。本轮真正的差集来自 **2026-09-24 ~ 09-30 DSH 的新增**，以及 parity plan §8 主动延后、至今仍未开工的部分。
3. **最大的结构性缺口是一条「矢量几何量测」层**：DSH `figure/render-check.ts`（1520 行）在**已生成的 SVG 源**上量测「文字被线条贯穿 / 文字与图线净距不足 / 点划线被实线覆盖 / 相邻零件剖面线难区分 / 内容越出画布」五类只有在渲染结果上才看得见的缺陷，并经 `verify_patent_figure` 工具暴露。本仓的 `pixel-gate` 只能吃**栅格图**，V 规则只能吃**自家 FigureSpec/SVG**——「外部/已交付 SVG 的几何复核」目前是真空白。
4. **第二缺口是交付物的字体独立性**：DSH 2026-09-28 起可经 Inkscape 把 SVG 文本转路径，产物不依赖读者字体。本仓 SVG 不带 `font-family`，中文标签在无 CJK 字体的机器（打印店、审查员查看器）会变豆腐块——而这份文件的全部用途就是被阅读。
5. **第三缺口是「谁拥有附图」**：DSH 2026-09-24 立了 **illustrator 角色**（硬产出契约 `figure-deliverable.md`、`allowedTools`、HITL、质量门第 6 项、标号表两向一致性的唯一权威）。本仓 `skills/patent-illustrator/SKILL.md` **不是 `type: role`**，不可由 `agent` 工具调度，质量门清单也没有附图项——而本仓的团队编排（M1）+ 角色配置化基础设施已经就位，**只差配置**。
6. 其余可引入项按性价比排序见 §4；**明确不建议照抄**见 §5（DSH 的 office 数值有已知错误，其 `fit_to_page` 默认值与本仓契约冲突）。

---

## 1. 时间基线（决定本轮差集的范围）

| 时间 | DSH | 本仓 |
|---|---|---|
| 2026-09-17 | `generate_structure_figure`（FreeCAD/TechDraw）、共享子进程骨架、引线标号落框、图面用语规则 | 附图核验加固 P0–P2（figure-gate 落地） |
| 2026-09-21 | office 档案 + 落版页 + 五种矢量图型（circuit/plot/cross_section/sequence/appearance） | — |
| 2026-09-22 | — | **parity plan 四个提交组全部落地**（SVG 安全门、V12–V14、WASM 后端、法域档案、落版页、图号条件化、pct） |
| 2026-09-24 | illustrator 角色 + 标号表权威（#278） | 核验拆规则注册表（#539） |
| 2026-09-25 | figure 生成器按关注点拆模块 | 曲线图/状态图/层级图/引线择位（9-22 后续叠加） |
| 2026-09-28 | **`verify_patent_figure` 工具 + 文本转路径（Inkscape）** | — |
| 2026-09-30 | **CAD 批次 T-03/T-06/T-07/T-10 ~ T-13/T-16/T-18/O-25**（剖面、剖面线、局部放大、多模型、线宽、隐藏线、标签间距、pnpm/pdf 经 SVG 链、页面旋转与字号） | 仅 CAD 投影失败诊断（c8bf33c65） |

**判据**：parity plan §8 自列的「未做」项 + 上表 09-24 之后的 DSH 新增 = 本轮的候选池。

---

## 2. 现状坐标

| 维度 | DSH | 本仓 |
|---|---|---|
| 制图源码 | `src/figure/` 12 396 行（35 个 `.ts`）+ `src/tool/` 制图相关 5 180 行 | `src/patent/figuregen/`（含 `cad/`）6 974 行（31 个 `.ts`）+ `src/patent/figure/` 3 204 行（17 个 `.ts` + 符号库 yaml）+ 工具层 2 378 行 |
| 制图测试 | 34 个 spec / 13 655 行 | 39 个 spec / 8 331 行 |
| 决策记录 | 8 篇 figure 相关 note + 5 份 openspec spec | **30 篇** figure 决策记录 + 2 份实施方案 + 3 份规则底座（逐句条文原文） |
| 工具面 | 6 个：`generate_patent_figure`、`generate_structure_figure`、`analyze_patent_figure`、`verify_patent_figure`、`add_patent_figure_references`、`search_patent_figure` | 5 个：`patent_figure_generate`、`patent_figure_project`、`patent_figure_check`、`analyze_patent_figure`、`search_patent_figure` |
| 支持图型 | flowchart、block、state、hierarchy、**circuit**、**plot**、**cross_section**、**sequence_diagram**、**appearance_view**（外观六面视图）、结构图（FreeCAD 多视图） | flowchart、block、state、hierarchy、chart（曲线图）+ CAD 投影（全剖视） |

---

## 3. 能力矩阵（谁强在哪）

| 能力维度 | 更强的一方 | 证据 |
|---|---|---|
| 工作流门禁 / HITL 阻断 | **本仓** | `src/patent/atoms/handlers/builtin/figure.ts:63,316,329`（`figure-gate`、`InterruptStageError`）；DSH 无对应物 |
| 交付物漂移检测 / 审计留痕 | **本仓** | sidecar（`src/patent/figuregen/sidecar.ts`）+ gate 比对；DSH 只有 index upsert |
| 确定性合规规则 + 法条溯源 | **本仓** | V1–V21（`check-rules.ts:64-576`）+ `skills/patent-illustrator/references/{cn,pct,uspto}-drawing-rules.md` 逐条原句；DSH 的 `compliance.ts` 仅 80 行 |
| 法域纸面常数 | 各有 | 本仓数值经 Gate 0 核验（parity plan 附录 A）；DSH `uspto.rightMm = 15` 与 37 CFR 1.84(g) 的 5/8 in（≈15.875mm）**不符** |
| 栅格/扫描件门禁 | **本仓** | `pixel-gate.ts`（PX1–PX4，中间灰/线宽/DPI/图号声明，诚实降级不做 OCR）；DSH 无 |
| **矢量几何量测（渲染事实）** | **DSH** | `figure/render-check.ts:1-70` + `tool/verify-patent-figure.ts:1-25`；本仓空白 |
| **交付物字体独立性** | **DSH** | `figure/inkscape-renderer.ts`（399 行）+ note `2026-09-28-inkscape-text-to-path-figure-export.md` |
| 图型覆盖 | **DSH** | 五种矢量图型 + 外观视图；本仓 parity plan §8 自认未开工 |
| CAD / 结构图深度 | **DSH** | 剖面轮廓（`freecad-section-geometry.ts` 416 行）、剖面线几何（`freecad-hatch-geometry.ts` 464 行）、局部放大、多模型、逐零件线宽、隐藏线样式、标签间距检查 |
| 多面板 / 跨图续号 | **DSH** | openspec `multi-panel-continuation/spec.md`；本仓 parity plan §8 第 4 项未做 |
| 外部 SVG 后处理（补标号） | **DSH** | `tool/add-patent-figure-references.ts:69`；本仓无 |
| 渲染后端抽象 | 平手（本仓更干净） | 本仓 `DotRunner` 接口把加工链与后端解耦（parity plan 附录 B）；DSH 把 dot-builder 与渲染器绑定 |
| 视觉分析路径 | 平手 | 两侧都走多模态门控（本仓 `analyzePatentFigure.ts:17` `supportsInputModality`；DSH `image-capability.ts` 明言移植自本仓） |
| 渲染后端规模护栏 | **DSH** | `figure/render-selector.ts:1-45`：WASM 主线程同步不可中断，按 DOT 长度/引擎把大图路由到 CLI（实测 800 节点 + `overlap=false` 需 139 s） |
| 用户交互层标注 | **本仓** | 附图标注面板（CHANGELOG v0.3.3 / `docs/notes/implemented/2026-09-28-figure-annotation-panel.md`）：`.svg` 预览内圈画、产出标注图、把图元锚定交给智能体；DSH 只有程序化 `svg-annotate`（按 label 文本匹配追加标号） |
| 回归护栏 | **本仓** | `scripts/figure-benchmark/gen-compliance.ts` + `baseline.json` + **不随 `--update` 放宽的语义锚点**（「单幅 pct 必无 caption」等）；DSH 无对标基准 |
| 架构不变量测试 | **本仓** | `tests/patent/figuregen/check-rules.spec.ts`：测「注册表覆盖全部规则号且顺序稳定」「每条规则可独立跑完且互不依赖」「规则是纯函数」「上下文无跨规则共享可变局部量」——让 21 条规则的注册表重构可安全进行 |
| 测试隔离手段 | 平手 | 本仓：假 `dot` 脚本冒充二进制（`tools-graphviz.spec.ts:73-93`，连「缺失 fail-closed」都能真跑）、FreeCAD 真实录制 JSON 边表 + 注入 runner、sharp/mupdf 现场生成；DSH：`describe.skipIf` + 替身端口 |

---

## 4. 值得引入的优点（按性价比排序）

### 速览

| 编号 | 一句话 | 价值 | 成本 | 批次 |
|---|---|---|---|---|
| P0-1 | 在**矢量源**上量测渲染事实（文字贯穿/净距/点划线被盖/剖面线难辨/越界）+「未量测」诚实清单 | 高 | 中（约 2 000 行移植） | A |
| P0-2 | 把 illustrator 立成可调度角色 + 硬产出契约 + 标号表权威 + 质量门附图项 | 高 | 低 | A |
| P0-3 | 字体独立导出（Inkscape 文本转路径，Config 门控 + 三道校验 + 原子换入） | 高 | 中 | A |
| P0-4 | 测试的「跳过即无信号」纪律（CI 信号守卫断言） | 中高 | 极低 | A |
| P0-5 | 降级但不静默（每次降级都要说明「谁因此漏了什么」） | 中 | 零 | A |
| P0-6 | WASM/CLI 规模护栏（按引擎 + DOT 长度路由） | 中 | 低 | A |
| P0-7 | **把已有核验接进阻断**（像素门禁 fail 目前不挂 HITL；输出契约是空壳） | 高 | 低 | A |
| P1-1 | 多面板 `panels` + `figure_family` 跨图续号 | 中高 | 中 | B |
| P1-2 | 外部 SVG 追加标号（内嵌/引线两种落位） | 中 | 中低 | B |
| P1-3 | 落版页旋转 + 图号/页码字号可调 | 中低 | 低 | B |
| P1-4 | 依赖外部二进制的工具默认不表面化 | 中低 | 低 | B |
| P2-1 | 图型扩展（sequence / circuit / appearance / plot 细化 / 矢量 cross_section） | 中高（分领域） | 高 | C |
| P2-2 | CAD 深度（模型剖面轮廓、剖面线分组、局部放大、多模型、逐零件线宽、隐藏线） | 中高 | 高 | C |
| P2-3 | 「宁可拒绝，也不静默取默认」（`require_explicit_hatch` 原则） | 中 | 零（评审项） | 随时 |
| P2-4 | 共享子进程骨架（消除 render-graphviz 与 cad/freecad 的同类重复） | 中 | 中 | C |
| P2-5 | 输出契约单点定义（组件枚举 / 标号表） | 低 | 低 | 随手 |

### P0 — 高价值、零 `inputSchema` 变更（不动 llm-replay fixture）

#### P0-1 矢量源渲染复核（本轮最大缺口）

- **是什么**：对新生成或外部交付的 SVG 做**几何量测**，报五类只有在渲染结果上才显现的缺陷：
  1. 文字被线条贯穿（引线穿过标号/元件名占位框）；
  2. 文字与图线净距不足（默认 1.5mm，把占位框外扩后同判）；
  3. 点划线被同位置实线覆盖（上下半剖公共边落在轴线上）；
  4. 相邻零件剖面线难以区分（方向差 + 间距比双判据，GB/T 4457.5）；
  5. 内容越出画布。
- **为什么值得**：这是「等价于人工看一眼图」的机器化，且**不需要栅格化器**——量测在矢量源上做，线段位置/线宽/字号即渲染输入。本仓现有两条通路都覆盖不到：`pixel-gate` 需要栅格图且只能判黑白/线宽/DPI；V 规则吃自家 structured spec，几何关系一律没判。
- **DSH 证据**：`packages/patent/patent-tools/src/figure/render-check.ts:1-70`（模块头列出五类与量测范围）；`glyph-box.ts`（275 行，字形盒/外扩/贯穿判定）、`svg-viewport.ts`（209 行，用户单位→毫米、嵌套 transform 继承）；工具面 `tool/verify-patent-figure.ts:1-25`。
- **同样值得学的设计**：**「未量测」诚实清单**——CSS 类样式、`<use>`/`<image>`、嵌套 `<svg>`、marker、`<tspan>` 位移、百分比长度、曲线弦近似……各记一条 `not-measured` 发现；「报告里没有 `not-measured` 时，『未发现问题』才等于逐类量测过」。这与本仓 `pixel-gate` 的诚实降级、`readback.ts:1-30` 的契约声明同一气质。
- **本仓落点**：新增 `src/patent/figuregen/render-check.ts`（纯函数）+ 在 `patent_figure_check` 的 `svg_paths` 分支内调用（**入参不变** ⇒ 零 schema 变更）；发现并入既有 `FigureCheckFinding` 结构（`rule`/`severity`/`message`/`evidence`）。
  - ⚠️ **实施时实测到的边界（2026-10-01）**：`svg_paths` 通路只接受**本仓产出**的 SVG——`parseFigureSvg` 要求图号（`data-figure-no` 属性或"图N"文本），外部/第三方 SVG 在该通路会被直接拒绝。故渲染复核当前服务的是**交付前自检与渲染器回归护栏**，不是"外部图核验"；后者的入口需要新增工具（属批次 B）。
  - ⚠️ **必须先处理的一处适配**（本报告初版未预见）：本仓内置渲染器把边标签放在连线中点上、用 `stroke="#FFFFFF" + paint-order="stroke"` 白描边把线在字周围挖空（`render-svg.ts` 的标签契约）。几何上线条确实穿过文字框 ⇒ 不豁免会把本仓**每一张带边标签的图**都报成"文字被贯穿"（实测 flowchart/state 必命中）。判据按样式特征（`paint-order` 含 stroke 且描边为白）豁免；DSH 是用 `data-dsh-role` 标注引线来豁免的，本仓无对应属性。
- **成本**：移植约 2 000 行（glyph-box + svg-viewport + render-check）+ 单测。本仓已有 `svg-safety.ts`（`assertSafeSvg`）可复用，安全门前置已就位。
- **风险**：低。纯函数、无 IO、不动产物契约。

#### P0-2 制图角色化：把 illustrator 立成可调度角色 + 标号表权威

- **是什么**：DSH 把附图从「技能文本」升级为**有所有者的岗位**：
  - 角色 `illustrator`（stance `neutral`）绑定 worker `patent-illustrator`；
  - **硬产出契约** `${caseOutputsDir}/{caseId}/figure-deliverable.md`，必填字段 `附图文件` / `附图标记表` / `图文一致性` / `形式要件核验`——使附图产出与其它 worker 一样被质量门校验；
  - `allowedTools` 明确列出五个制图工具 + `read`/`write`；禁止实质结论（权项布局、保护范围、修改方案）、禁止新颖性/创造性判断、禁止替任一方撰写；`triggersHITL = true`；
  - **标号表所有权**：图面 ↔ 标号表 ↔ 说明书 三处两向一致性的唯一权威；
  - 质量门新增第 6 项「附图与标号」；组包（起草/OA答复/补正/复审）插入制图任务。
- **为什么值得**：本仓 `skills/patent-illustrator/SKILL.md`（176 行）内容其实比 DSH 的规则底座更细（V 规则、法域图号表、括号禁令），**但它只是技能文本**：frontmatter 无 `type: role`，`agent` 工具无法按 `subagent_type` 调度它。更关键的是**没有一个角色对附图绘制质量负责**（已逐文件核验）：`skills/patent-quality-checker/SKILL.md` 无附图项；`skills/patent-formal-exam/SKILL.md:30` 明确把「说明书附图绘制质量」列为**不审查**事项；`skills/patent-reviewer/SKILL.md:20` 只审「附图标记」一致性（不是绘制质量）。结果是附图质量落在「主代理是否记得」上。DSH 的 note 记录了同类判据：语料中 313 个任务里 122 个（39%）涉及附图，21 个团队里 15 个至少有一起附图任务——而 13 个角色没有一个拥有它。
- **DSH 证据**：`.agents/notes/implemented/feature/2026-09-24-patent-team-illustrator-role.md`（含 `## Alternatives considered` 与后果）。
- **本仓落点**：纯配置层——`skills/patent-illustrator/SKILL.md` 补 `type: role` frontmatter（`domains`/`tools`/`readOnly`/`systemPrompt`，过 `scripts/validate-skills.mjs`）+ 质量门清单加附图项 + 团队组包加制图任务。**零 schema、零 fixture 影响**。
- **成本**：低（1 个工作日量级）。**价值**：高（把「主代理是否记得核验」变成岗位职责）。
- **注意**：本仓已有 `figure-gate` 兜住流程；角色化补的是**责任归属与产出契约**，两者互补不重复。

#### P0-3 字体独立导出（交付物的物理可读性）

- **是什么**：给 SVG 加一个可选的收尾步骤——系统 Inkscape `--export-text-to-path`，把字形换成轮廓路径，产物不再依赖读者机器上的字体。
- **为什么值得**：本仓生成的 SVG **不带 `font-family`**，中文标签的呈现取决于读者环境；打印店/审查员查看器缺 CJK 字体即豆腐块。这是**交付物层面**的缺陷，且本仓所有流程门禁都检测不到（不报错、能打开、就是读不出）。
- **DSH 证据**：`.agents/notes/implemented/architecture/2026-09-28-inkscape-text-to-path-figure-export.md`；实现 `figure/inkscape-renderer.ts`（399 行）。其设计要点全部值得照搬：
  - **最后一步执行**：落版之后、索引写入之前，后续无人再解析该文件；
  - **仅 SVG**；png/pdf 由渲染器自己画字形，故显式报「未生效」而非静默；
  - **缺失即 fail loud**：无 Inkscape → `setup_required` 带安装指引；转换后仍含 `<text>` → `render_failed`；
  - **产物先校验再原子换入**：安全门 + 无残留 `<text>` + 几何守卫（墨迹离开原图 > 1mm 即拒），全过才 `writeFileAtomic` 写回；被拒时原文件逐字节不变；
  - **复用共享子进程骨架**（可执行发现、spawn 宽限、deadline、失败分类与 Graphviz/FreeCAD 同一套）。
  - **代价如实声明**：外部 GPL 二进制（~645MB）、每图约 0.4s、文件大约 10 倍（轮廓替代 `<text>`）、文字不再可搜索/可就地编辑；渲染复核在文本版上先跑。
- **本仓落点**：`Config` 门控（默认关）+ 新 `figuregen/inkscape-renderer.ts`，**零 schema 变更**（DSH 就是 `Config.figureTextToPath`）。
- **成本**：中。**风险**：中低（依赖外部二进制，但门控 + fail-loud 可控）；对含中文的 PDF 导出尤其相关（DSH 实测 Inkscape 1.4.4 对个别中文字形会写出截断 PDF 且退出码为 0，故必须验产物完整性）。

#### P0-4 测试的「跳过即无信号」纪律（方法论，成本极低）

- **问题**：依赖真实外部二进制的用例（FreeCAD / Inkscape / dot / WASM）在缺依赖时整组 `skip`，日志读起来是**绿的**——「CI 上从来只是 5 条跳过」，把「没跑」伪装成「通过」。
- **DSH 做法**：真实依赖用例仍 `describe.skipIf(!hasX)` 自跳过，但**另设一条只在 CI 生效的守卫**（`tests/figure-graphviz-ci-signal.spec.ts:2-10,18,27`：`onCi` 判据 + 断言 `dot` 与 `fonts-noto-cjk` 确实装了），把「绿色但没跑」变成红灯。并在真实用例文件头写明「跳过即『无信号』而不是『通过』；要信号得把依赖装进 CI 镜像」（`figure-inkscape-real-render.spec.ts:22-24`）。
- **为什么值得（本仓实测证据，不是假想风险）**：本仓**恰好 5 处条件 skip**，条件统一为 `resolveDotBinary() === null ? "graphviz not installed" : false`：`tests/patent/figuregen/dot.spec.ts:232,259,283,338`（真机 dot 4 条）+ `svg-safety.spec.ts:95`（Graphviz 产物过安全门）。⇒ **CI 上（无系统 dot）真机 graphviz 行为默认不被验证**，仅由 WASM 通路的 2 条真机用例部分代偿。叠加上无 golden 文件（§5.5 第 4 条），「布局/输出正确性」实际处于**双无信号**状态。
- **DSH 做法（双层）**：① 真实依赖用例仍 `describe.skipIf` 自跳过，但**另设一条只在 CI 生效的守卫**（`tests/figure-graphviz-ci-signal.spec.ts:2-10,18,27`：`onCi` 判据 + 断言 `dot` 与 `fonts-noto-cjk` 真装了），把「绿色但没跑」变成红灯；② 用 `scripts/test-skip-baseline.json` 守 skip 的**总量**（9-30 的 CAD 提交同步更新了它）。用例文件头写明「跳过即『无信号』而不是『通过』；要信号得把依赖装进 CI 镜像」（`figure-inkscape-real-render.spec.ts:22-24`）。
- **本仓落点**：为 graphviz / FreeCAD / Chromium 打印三条外部依赖链各加一条 CI 守卫断言 + 引入 skip 基线；并在真实用例文件头写明跳过语义。**零契约变更、纯测试侧**。顺带修 §5.5 第 3 条那处自证式断言——它是同一类问题的另一形态（**护栏写了但没守住**）。
- **成本**：极低。**价值**：中高（防止整条链路长期无信号）。**建议**：与 P0-1 同批做（同一文件区域内）。

#### P0-5 降级但不静默（设计检查项）

- **是什么**：DSH 多处「不阻断但必须说清后果」：索引写入失败 → 降级为警告且**把原因留在模型可见的 warnings 里**，并点明后果「索引缺失会使 `search_patent_figure` 漏检、`figure_family` 续号漏号」（`src/tool/figure-output.ts:46-48`）；引线放置无空间 → 退化为内嵌标号 + 警告，**绝不画压盖引线**（`figure/leader-line.ts:12-13`）；引线标注被安全校验拒绝 → 降级为警告（「图已生成，不吞工件」，`tool/figure-render-plan.ts:24,42-43`）。
- **为什么值得**：本仓文化已经是 fail-loud，但「降级路径是否把**后果**说给模型听」值得作为固定检查项。本仓 `readback.ts`/`pixel-gate` 已有诚实降级的雏形，可统一成一条评审清单：*每一次降级都要能回答「谁因此漏了什么」*。
- **成本**：零（评审习惯）。**风险**：无。

#### P0-6 渲染后端的规模护栏

- **是什么**：WASM 渲染是主线程同步调用、不可中断，规模直接决定事件循环被占用的最坏时长。DSH 的 `render-selector` 按引擎与 DOT 长度路由：文本格式走 WASM，png/pdf 走 CLI 兜底；强制导向引擎（`neato`/`fdp`/`sfdp`）超过阈值即改走 CLI，由子进程 deadline 兜住。
- **为什么值得**：本仓 `graphviz-wasm` 已是 opt-in 后端（`SATI_FIGURE_RENDERER`，parity plan W0-3），但**没有规模判据**——大图走 WASM 会同步阻塞服务进程。DSH 给了可复算的实测数：`dot` 3 000 节点约 0.4s，而强制导向 800 节点已需 3.4s，叠加 `overlap=false`/`splines=true` 后 800 节点需 139s。
- **DSH 证据**：`figure/render-selector.ts:1-45`。
- **本仓落点**：`render-graphviz.ts` 的 `DotRunner` 选择处加规模判据（引擎白名单 + 长度/节点数阈值），超限走子进程 runner 或 fail-loud 提示。**零 schema**（环境变量/programmatic，不进 inputSchema）。
- **具体阈值可参照**：`WASM_MAX_FORCE_DOT_CHARS = 20_000`、`WASM_MAX_HIERARCHICAL_DOT_CHARS = 64_000`（`src/figure/render-selector.ts:47,50`），按 `spec.dot.length`（UTF-16 码元）计。**不可直接照抄**——阈值应按本仓硬件重新实测，DSH 的数值可作起点。
- **成本**：低。**风险**：低。

#### P0-7 把已有核验接进阻断（本仓自身的接线缺口，与 P0-1 同批最自然）

- **缺口一：像素门禁的 fail 不挂 HITL**。`figure-gate` 的 fail 判定只统计 `checkFigures` 的结构化 findings（`src/patent/atoms/handlers/builtin/figure.ts:327`），而 `pixel-gate` 只被 `patentFigureCheck.ts` 导入（全仓 grep 确认）⇒ **PX1「中间灰占比 > 30%」这类严重缺陷只在报告里出现，不会中断流程**。这与本仓「最终质量的最后一道自动门是 `figure-gate`」的设计意图相悖。
- **缺口二：三个制图工具的 `outputSchema` 是空壳**。`{type:"object",properties:{}}`（`patentFigureGenerate.ts:109`、`patentFigureCheck.ts:98`、`patentFigureProject.ts:93`），而 `ToolRuntime` 的输出校验前置条件是 `output.data !== undefined`（`src/tool/execution/ToolRuntime.ts:336-351`），这三个工具的 `execute` 只返回 `content` ⇒ **输出契约强制形同虚设**，尽管 registry 开着 `requireOutputSchema: true`（只在「已声明」层面自洽）。
- **为什么值得**：这是本报告里**唯一一类「本仓比 DSH 弱、且属实现缺陷而非取舍」**的项——DSH 的 `verify_patent_figure` 与 `generate_patent_figure` 输出均有真实 schema 与量测值。它与 P0-1 是同一件事的两半：**P0-1 补上「量什么」，P0-7 补上「量到问题会怎样」**。
- **落点**：① `figure-gate` 的 gate 输入增像素门禁结论（或在 `figure.ts` 内联 `pixel-gate`，仅当存在栅格附件时）；② 三个工具补真实 `outputSchema` + 返回 `data`。
- **⚠️ 注意**：补 `data` 后输出契约**首次**对这三个工具生效，既有消费方（若按 text 行解析路径）可能受影响——应先加 schema 观察一轮，或在同一 PR 内同步消费方。**零 `inputSchema` 变更 ⇒ 不触发 fixture 重录**（输出 schema 不入请求键）。
- **成本**：低。**风险**：中低（唯一风险是启用校验后暴露既有的字段漂移——这正是它该暴露的）。

### P1 — 中高价值，需**一次合并的 schema 变更**与 fixture 重录
> 本仓纪律：改任一 `inputSchema`（含描述文本）或新增/删除工具 ⇒ llm-replay 请求键失配，必须重录（parity plan §1.1 已核实 `requestInvariant.ts:75` 的 digest 组成）。以下三项应**合并为一次重录**。

#### P1-1 多面板 panels + `figure_family` 跨图自动续号

- **是什么**：一次调用产 FIG. 1A/1B 多面板，共享一套标号序列（不重号、不留空）；声明发明家族后，后续图自动复用已分配标号并为新组件续号。
- **为什么值得**：这是真实案件的高频形态（同一部件的不同视角/局部），本仓 parity plan §8 第 4 项**自己把它列为未做**，理由是「与 schema 变更不得混在一次重录里」——本轮正好可以单独安排。
- **DSH 证据**：`openspec/specs/patent-figure/multi-panel-continuation/spec.md`（含「panels 与顶层结构同给即拒绝」「空 panels 即拒绝」「家族声明缺省行为不变」等边界场景）；**已实现**：`src/tool/generate-patent-figure.ts:197`（`generatePanels`）、`:1058`（与顶层结构互斥），面板共享一条连续标号系列。
- **本仓落点**：`FigureSpec` 增 `panels`/`family` 载荷 + 编号分配算法（本仓已有 `multi-figure-consistency` 与跨图同件同号的既有约定可复用）+ sidecar 记录家族标号。
- **成本**：中（新入参 + 算法 + 快照/基准更新）。**风险**：中（画幅与编号强耦合，需同步更新生成侧基准 `scripts/figure-benchmark/`）。

#### P1-2 外部 SVG 追加标号（`add_patent_figure_references` 等价物）

- **是什么**：对**用户自己渲染/已有的**流程图或框图，按 label 文本匹配追加参考标号；两种落位——内嵌 ` (20)` 或引线外置。
- **为什么值得**：本仓的标号只能在 `patent_figure_generate` 生成路径产生；`patent_figure_check` 的 `svg_paths` 只**回读核验**、不写入。客户拿来一张旧图/第三方图要求补标号时，目前只能靠模型手改 SVG（本仓纪律恰好禁止自建脚本代替工具）。
- **DSH 证据**：`tool/add-patent-figure-references.ts:69`（输入 `svg_path` + `references` + `leader_lines` + `output_filename`；未命中项进 warnings）；`figure/svg-annotate.ts`（183 行）；`figure/leader-line.ts`（906 行）。
- **本仓落点**：本仓已有择位引擎 `src/patent/figuregen/leader-line.ts`（517 行，CAD 通路）与 `assertSafeSvg`，新增一个工具即可复用。**新增工具 ⇒ 请求键变更（同批重录）**，且会改 `default_tool_count`/`patent_tool_count`（需 `pnpm gen:doc-claims`）。
- **成本**：中低。**风险**：低。

#### P1-3 提交面参数：页面旋转、图号/页码字号
- **是什么**：`submission-page` 暴露 page rotation、caption/sheet 字号（DSH T-04/T-05）。
- **为什么值得**：本仓落版页的字号目前是内部常量；横排/特殊幅面案件无法调。属「小参数、真需求」。
- **DSH 证据**：commit `de58c98462`（`figure/submission-page.ts` +98/-29，`tool/figure-submission.ts` +72）。
- **成本**：低（参数透传）。**风险**：低。

#### P1-4 依赖外部二进制的工具默认不表面化

- **是什么**：DSH 的 `generate_structure_figure`（依赖本机 FreeCAD）由 `Config.structureFigureEnabled` 控制且**默认 false——工具根本不注册到工具表**（`freecad-structure-figure-seam` 笔记：「工具数 27→28」只在开启时）。
- **为什么值得**：本仓三个制图工具由同一个 `options?.patentFigure !== false` 开关注册（`src/tool/registry/createBuiltinRegistry.ts:222,370`），即 `patent_figure_project` **默认对模型可见**，但它依赖 `SATI_FREECAD_CMD`/本机 FreeCAD，未装时必然 `setup_required`。让模型看到一批必然失败的调用既浪费轮次也污染工具面（本仓已有 `visibleDomains`/`hiddenDomains` 的域裁剪机制可复用）。
- **成本**：低（拆一个独立开关）。**风险**：低，但**注意**——改注册面会改变工具列表 ⇒ 请求键变更 ⇒ 与批次 B 合并重录（不可放进批次 A）。
- **反向意见**：本仓现有「默认可见 + fail-closed 带安装引导」也是一种选择（模型能学到该环境缺什么）。是否改取决于部署形态；若发行版面向「已装 FreeCAD 的专利工程师」，保持默认可见即可。

### P2 — 分领域立项（价值确定但工程量大）

#### P2-1 图型扩展

| 图型 | DSH 证据（行数） | 本仓状态 |
|---|---|---|
| 电路图 `circuit` | `figure/circuit-diagram.ts` 749 行（电气符号、正交走线、结点圆点、标签候选择位） | **未开工**（parity plan §8 第 2 项） |
| 时序图 `sequence_diagram` | `sequence-diagram.ts` 292 行（参与者盒、生命线、同步/返回/异步箭头、激活条） | **未开工** |
| 外观设计六面视图 `appearance_view` | `appearance-view-sheet.ts` 279 行（第一角/第三角投影惯例、公共缩放比保证比例一致、视图名标在正下方） | **未开工**；本仓有 `skills/provision-design-auth` 但无排版能力 |
| 独立曲线/坐标图 `plot` | `plot-diagram.ts` 412 行（开口箭头轴、朝外刻度、轴标目含单位、图例折行、不标比例） | 本仓有 `kind: "chart"`，但 DSH 的轴/刻度/图例细节更完整 |
| 矢量剖视图 `cross_section` | `section-diagram.ts` 854 行 + `section-source.ts` 512 行 | 本仓的剖视只在 CAD 通路（从 STEP 取），**不由调用方直接给轮廓** |

- **建议**：按「软件/算法类（sequence）→ 电气（circuit）→ 外观设计（appearance，另需核验 37 CFR 1.152 等）→ 曲线细化」分批，每批独立重录。
- **注意**：DSH 的 `appearance-view-sheet` **只做版面组合、不画图**（调用方给毫米坐标片段）——本仓若引入，应如实声明同样的边界。

#### P2-2 CAD / 结构图深度

DSH 在 2026-09-30 一天内有 9 个提交推进 CAD（`freecad-*` 新模块合计约 2 500 行）：

| 能力 | DSH 证据 | 本仓差距 |
|---|---|---|
| 从模型切剖面轮廓（无文档、`Shape.slice` 闭合环 → 材料外环 + 孔环） | `freecad-section-geometry.ts` 416 行、`freecad-section-script.ts` 281 行（T-10/T-12） | 本仓 `cad/freecad.ts` 614 行做投影 + 全剖视，轮廓归并/孔环处理深度不足 |
| 剖面线几何（视图帧成面、`makeGeomHatch` 精确裁剪孔、按材料区域分组） | `freecad-hatch-geometry.ts` 464 行、`freecad-hatch-script.ts` 211 行（T-11） | 本仓 `render-cad.ts` 的剖面线为固定 45° 细实线按纸面毫米间距填充（确定性但无分组/裁剪语义） |
| 局部放大视图（模型坐标窗口 + `DrawViewDetail`） | commit `208a704a72`（T-13） | 无 |
| 多个模型投影到一张结构图 | commit `c8a05e33da`（T-16） | 无 |
| 逐零件线宽 + 隐藏线样式 | `structure-svg-postprocess.ts` 127 行（T-03/T-07） | 无（本仓 CAD 线宽为常量） |
| 标签净距检查 | `render-check.ts` +366（T-18） | 无（同 P0-1） |
| **`require_explicit_hatch`：拒绝静默使用默认剖面线** | commit `2905ad88f8` | 无 —— 见下 |

#### P2-3 值得单独记下的设计原则：宁可拒绝，也不静默取默认

`require_explicit_hatch`（`vector-figure-build.ts` +29）的做法是：剖面线的方向/间距若有多种合理默认，工具**拒绝**而非替你选一个。这与本仓既有的 fail-loud 文化（`assertBlackWhite` 不放宽、CAD 缺失不静默回退、`readback` 对契约外 SVG 明确声明）同源，但本仓在**渲染参数**层面仍有若干隐式默认（如 CAD 剖面线角度/间距）。建议作为一条评审检查项引入，而不必逐点照抄 DSH 实现。

#### P2-4 工程重构：共享子进程骨架

- **是什么**：把「可执行发现（override → env → 平台候选 → PATH）、spawn 宽限、deadline 与取消合一、stderr 摘录、失败措辞」抽成一个模块，Graphviz / FreeCAD / Inkscape 三个渲染器共用；失败因归一分序：**内部超时 > 调用方取消 > 终止信号 > 退出码**。
- **为什么值得**：DSH 是因为 jscpd 报出四对克隆才做的（note 明确拒绝用 `jscpd:ignore` 掩盖：「重复代码承载共享契约——一种失败因序、一种组件结构」，掩盖会掩盖检测器本要抓的漂移）。本仓存在同类重复：`render-graphviz.ts:36 resolveDotBinary` 与 `cad/freecad.ts:77 resolveFreecadCmd` 各写一套「env 覆盖 → 候选/PATH 探测」，`describeCadFailure`（:536）与 graphviz 的失败处理各自独立。
- **已实测到的一处行为不一致**（正是 DSH 所说「漂移会悄悄发生」的实例）：
  - `resolveDotBinary`：显式覆盖 `SATI_GRAPHVIZ_DOT` **只做 trim、不校验存在性**，坏路径原样返回，失败推迟到渲染期；
  - `resolveFreecadCmd`：显式覆盖 `SATI_FREECAD_CMD` **校验存在性，不存在即抛 `TypeError`**（fail-loud）。
  - DSH 的统一契约是「显式覆盖 → 环境变量 → 平台候选 → PATH，且**覆盖值不存在不回落**」——两种行为都应归到这条契约下（建议采用 freecad 侧的 fail-loud）。
- **DSH 证据**：`.agents/notes/implemented/simplification/2026-09-17-figure-tools-shared-bootplate.md`；`figure/subprocess-render.ts`（242 行，`findExecutable`/`spawnRenderProcess`/`startRenderDeadline`/`describeRenderFailure`）。
- **成本**：中（重构，需保持现有单测注入面）。**风险**：低（可分批）。

#### P2-5 输出契约单点定义（**先修前提，再看是否引入**）

- **DSH 做法**：三个制图工具共用的输出片段（`FIGURE_COMPONENT_KINDS`、`NUMERAL_MAP_SCHEMA`、`COMPONENT_SCHEMA`）单点定义在 `tool/internal/figure-schemas.ts`，理由「字段或枚举漂移会让同一份附图数据在不同工具间不可互换」。本仓已有**入参侧**单点（`patentFigureSchema.ts:7-8`）。
- **⚠️ 但本仓的输出侧根本还没生效**（详见 §5.5 第 1 条）：三个制图工具的 `outputSchema` 是 `{type:"object",properties:{}}` 空壳，且 `execute` 不返回 `data` ⇒ 单点定义无处落地。
- **结论**：**先让输出契约真正生效**（抽出真实 `outputSchema` + `data`），再谈「单点定义」——否则只是把空壳集中到一处。**不建议**先做单点。
- **成本**：低（写 schema + 补 `data`）；但会让既有消费方首次受校验约束（见 §5.5 的注意项）。

---

## 5. 明确不建议照抄

| 事项 | 理由 |
|---|---|
| DSH 的 office 数值（尤其 `uspto.rightMm = 15`） | 与 37 CFR 1.84(g) 的「右 ≥5/8 in（≈15.875mm）」不符；parity plan §2.1 已点出两处分歧。本仓数值经 Gate 0 核验并留痕，**以本仓为准** |
| DSH 的 `fit_to_page` 默认 `true` | 本仓产物契约是 `<name>-figN.svg` + sidecar（`figure-gate` 依赖它做漂移检测），默认改写会同时冲击调用方与门禁；本仓默认 `false` + 附加落版页是有意为之（parity plan E4） |
| DSH 的 `semantic` 彩色模式 | 会动摇本仓贯穿渲染/核验/像素门的「构造期黑白不变式」，且需先核验各法域彩色提交程序。要立须单独立项 |
| 栅格输出（png/pdf）作为主产物 | 本仓立场：矢量为主 + Chromium 打印出 PDF；且 `pixel-gate` 已能**核验**栅格图，产出栅格的价值不明确。DSH 的 T-06（经 SVG 链导出、落版生效）可借鉴其**链路顺序**，但不必改变本仓产物契约 |
| 无条件转路径（无 Config 门） | DSH 自己否决过：「没有 Inkscape 的部署仍须能出图，且绘图员要在矢量编辑器里收尾时 `<text>` 版本是更好的产物」 |
| `allowedTools` 的运行时强制 | DSH 明确延后：该字段是声明式元数据，无运行时消费者；强制会改变全部 worker 的行为。本仓引入角色化时同样只做声明 |

---

## 5.5 顺带发现：本仓自身的缺口（不是与 DSH 的差异，但直接影响交付质量）

两路采集交叉确认的实测结果，建议与批次 A 一并处理（第 1、2 条即 P0-7）：

1. **输出契约空壳**：三个制图工具的 `outputSchema` 是 `{type:"object",properties:{}}` 且 `execute` 不返回 `data` ⇒ 输出契约强制形同虚设（详见 P0-7 缺口二）。
2. **像素门禁不参与阻断**：`pixel-gate` 的 PX1 fail 不挂 HITL（详见 P0-7 缺口一）。
3. **一处自证式断言（测试质量问题）**：`tests/patent/figure-gate.spec.ts:82-91` 的用例标题声称校验「名称/类别/输入输出键（描述不含阈值数字）」，但测试体里 `atom` 是**测试内新建的本地字面量**，两处 `deepEqual` 是字面量比自己，**从未触碰真实的 `FigureGateHandler`**（定义在 `src/patent/atoms/handlers/builtin/figure.ts`）；同用例只有 `instanceof` 与 `category === "gate"` 是真断言。
   - ⚠️ **就地更正（2026-10-01 复核）**：本条原写「『阈值不进模型可见面』在代码里成立，**但没有测试在守它**」——**该结论不成立**。`tests/patent/drafting-sop.spec.ts:478-493` 的「隐藏清单」用例对**真实** `figureGateAtom.description` 与 manifest 阶段描述做 `NUMERIC_ASSERTION` 正则断言，那是真护栏。准确的问题是**测试质量**而非护栏缺失：figure-gate.spec 里多了一处看起来在守、实际零检测力的重复（已就地改为断言真实原子）。它仍是 P0-4 的好反面教材——绿灯不等于被验证过。
4. **无 golden/snapshot 文件**：全部「逐字节确定性」断言都是**同一进程内两次调用**比较（`dot.spec.ts:37-39`、`render.spec.ts:184-188`、`chart.spec.ts:582-586`、`leader-line.spec.ts:290-304`）⇒ 能抓随机/时钟/Map 迭代序这类回归，**抓不到跨 graphviz 版本或跨平台的布局漂移**——而决策记录自己承认「跨 graphviz 版本布局可能有差异」。两者并不矛盾，但「有确定性测试」≠「有跨版本漂移护栏」。
5. **两个已实现但生产不可达的模块**：`src/patent/figure/pdf-extract.ts`（mupdf 页面转图 + 候选附图页启发式打分）与 `netlist-viz.ts`（网表可视化 Mermaid/SVG/摘要）在全仓**只有 barrel 导出与 spec，没有任何工具调用方** ⇒ 目前不存在「PDF → 图 → 分析」的生产路径，网表可视化也不出现在任何工具输出里。
6. **无测试入口的模块**：`src/patent/figure/preprocess.ts`（三级压缩级联 `1600px/q80 → 1200px/q55 → 800px/q40`、5 MiB 预算、MIME 探测分支均无断言，仅 happy path 被工具层 spec 间接跑到）与 `src/patent/figure/mime.ts`（5 条映射无断言）。
7. **六处低风险瑕疵**（顺手项）：`V6` 不在规则联合类型里（属构造期不变量，非漏实现，但易被误读）；规则侧 `info` 级不可达（9 个 wording kind 全为 warn，`info` 实际只出现在 `pixel-gate`）；`PIXEL_INK_MAX` 定义后全仓无引用；**`format` 非法值在产物落盘之后才抛**（异常路径会留下半成品目录）；`sheet_index`/`sheet_total` 三工具处理不一致（generate/project 未成对即抛，check **静默忽略**）；`svg_paths` 回读的骨架用占位 `kind: "flowchart"` ⇒ V19/V20/V21 在回读通路不生效。
   - ⚠️ **2026-10-01 复核更正**：`V6` 一项**不成立**——它已在 `check.ts:63` 与 `tests/patent/figuregen/check-rules.spec.ts:21` 明确注释为「渲染器构造期不变式，不在此重复」，读代码的人不会被误导。其余五项照旧；其中 `format` 落盘顺序、`PIXEL_INK_MAX` 零引用、`sheet` 三工具不一致三项本批已修（见 §7）。

> 与之对照，DSH 的 `scripts/test-skip-baseline.json`（skip 数量基线，随 9-30 的 CAD 提交更新）说明它**同时在治理 skip 的总量**——本仓第 3、4 条正是「护栏存在但没守住」的两个具体形态。

## 6. 建议批次与门禁影响

| 批次 | 内容 | schema 变更 | fixture 重录 | 其他门禁 |
|---|---|---|---|---|
| **A（并行，零 schema）** | P0-1 矢量渲染复核、P0-2 角色化、P0-3 字体独立导出、P0-4 测试信号守卫、P0-5 降级检查项、P0-6 规模护栏、**P0-7 把核验接进阻断**、**§5.5 的 7 条本仓缺口** | 否 | 否 | 新增 `.ts` ⇒ `pnpm measure:update`；角色化 ⇒ `pnpm check:skills`、`pnpm check:patent-sop` |
| **B（一次重录）** | P1-1 多面板/家族续号、P1-2 外部 SVG 补标号（新增工具）、P1-3 提交面参数、P1-4 工具表面化开关 | **是** | **是（同批一次）** | `pnpm gen:doc-claims`（工具计数）、`pnpm gen:patent-workflow-docs`、生成侧基准更新 |
| **C（分领域立项）** | P2-1 图型扩展（按 sequence → circuit → appearance 分批）、P2-2 CAD 深度 | 是（每批各自重录） | 是 | 同上 + 法条核验（外观设计需另行核验条文） |

**跨批次硬约束**（沿用 parity plan §1.1/§5.9）：

1. 批次 B 必须在 main 上 `llm-replay-real.spec` 为绿时进行，且该批内**不得夹带**其他 schema 改动（否则出问题无法二分定位）。
2. 阈值/评分线不得写进 `Atom.description` 与 manifest 阶段描述（worker 可见面）。
3. 新增法域/图型必须「未核验即不写成规则」——DSH 的数值只能作为**待核验线索**，不能作为依据。
4. 决策记录：每批附 `docs/notes/implemented/` note，含 `## Alternatives considered`。

---

## 7. 实施记录（2026-10-01，批次 A）

分支 `feat/patent-figure-batch-a`。**零 `inputSchema` 变更** ⇒ 未触发 llm-replay fixture 重录。

| 项 | 状态 | 落点 | 决策记录 |
|---|---|---|---|
| P0-7 核验接进阻断 | ✅ 已落地 | `figure-gate` 接栅格像素门禁（PX fail 同权参与阻断）；三个工具补真实 `outputSchema` + canonical `data` | `2026-10-01-figure-gate-raster-and-output-contract.md` |
| P0-1 矢量源渲染复核 | ✅ 已落地 | 移植 `glyph-box`/`svg-viewport`/`render-check`（约 2 100 行 + 47 用例）并接入 `svg_paths` 通路（规则族 `RC1`–`RC5` + `RC0`） | `2026-10-01-figure-render-check-port.md` |
| P0-3 字体独立导出 | ✅ 已落地（默认关） | `inkscape-renderer.ts`（915 行）+ 接入 generate/project + sidecar 记 `text_to_path` | `2026-10-01-figure-text-to-path.md` |
| P0-2 制图角色化 | 🔶 部分 | 角色化（`type: role` + 硬产出契约 + 越界禁令）、质量门第 6 项、三处责任归属已落地；**worker 契约（`defaultPatentWorkers`）与 manifest 组包未做** | 提交 `411f6ff1f` |
| P0-4 测试信号守卫 | ✅ 已落地 | CI 装 graphviz（把 5 处 skip 兑现为真跑）+ `external-dependency-signal.spec.ts`（CI 断言 dot 可用）；**skip 总量基线未做**（理由见该提交） | 提交 `3836df0c7` |
| P0-5 降级但不静默 | ✅ 已落地 | `AGENTS.md` 规则 11 + `docs/development-standards.md` §6 由三条扩为四条 | 提交 `d980c55a5` |
| P0-6 规模护栏 | ✅ 已落地 | `WASM_MAX_DOT_CHARS`（64 000，在实例化**之前**生效） | 提交 `5178ca053` |
| §5.5 本仓缺口 | ✅ 多数已修 | 输出契约空壳、像素门禁不阻断、自证式断言、`format` 落盘顺序、`PIXEL_INK_MAX` 零引用、`sheet` 三工具一致性、`preprocess`/`mime` 测试入口、两个不可达模块（模块头标注 + backlog 记账） | 见各提交 |

**未做并如实记下**：① P0-2 的 worker/manifest 组包（要同步手册与工作流 yaml 快照，另开提交）；② P0-4 的 skip 总量基线；③ §5.5 第 5 条的**处置**（仅标注 + 记账，接线需扩工具入参 ⇒ 属批次 B）。

### 7.1 实施中新增的发现（本报告初版未预见）

1. **`svg_paths` 到不了外部 SVG**（§4 P0-1 落点已就地更正）——`parseFigureSvg` 要求图号，外部 SVG 在该通路被直接拒绝。渲染复核的实际定位从"外部图核验"校正为「交付前自检 + 渲染器回归护栏」。
2. **边标签的 halo 契约**——本仓用 `stroke="#FFFFFF" + paint-order="stroke"` 白描边挖空连线实现标签可读性，与 DSH 的 `data-dsh-role` 豁免机制不同。不按特征豁免会让判据在自家产物上退化成噪音（实测 flowchart/state 必命中）。已加回归钉：本仓产物只报 `not-measured`。
3. **文本转路径与图号回读的冲突**——`parseFigureSvg` 的 `numbered` 明确「属性不算」，转路径后必然读不到，会让 V15「多幅须编号」误报 fail。已用 sidecar 的 `text_to_path` 标记把回落限定在"确实转过路径"的产物上（未转路径时绝不回落，否则会蒙掉图号被删的漂移信号）。
4. **`stroke-dasharray` 的单位换算被一度误判为缺陷**——移植过程中曾判定"换算两次"，复核后**否定**：`dashPatternUser` 返回用户单位、全链路只乘一次累计缩放，换算正确；同一属性值在 px 文档得 2.12mm、在 mm 文档得 8mm 正是换算链生效的证据。该条已由"待修"改为钉子用例。
5. **§5.5 第 3 条原结论过重**（已就地更正）——「隐藏清单」纪律一直有真护栏（`drafting-sop.spec.ts:478-493`），问题只是 figure-gate.spec 里多了一处零检测力的重复。

> 这五条的共同形态值得记下：**本轮实测到的问题几乎没有一条是"判据写错了"，全都是"判据没接上、没在守，或判据适用面被高估"**——这正是 P0-5（降级但不静默）与 P0-7（把已有核验接进阻断）被列为高价值项的原因。

---

## 附录：证据索引

**DSH 源码**（`/Users/xujian/projects/deepseek-harness/packages/patent/patent-tools/`）
- `src/figure/render-check.ts`（1520 行，五类渲染事实量测 + not-measured 清单）
- `src/figure/glyph-box.ts`（275）、`src/figure/svg-viewport.ts`（209）
- `src/tool/verify-patent-figure.ts`（工具面）
- `src/figure/inkscape-renderer.ts`（399，文本转路径）
- `src/figure/subprocess-render.ts`（242，共享子进程骨架）
- `src/figure/render-selector.ts`（83，后端选择与规模路由）
- `src/figure/office-profile.ts`（180）、`submission-page.ts`（298）、`compliance.ts`（80）
- `src/figure/circuit-diagram.ts`（749）、`plot-diagram.ts`（412）、`sequence-diagram.ts`（292）、`appearance-view-sheet.ts`（279）、`section-diagram.ts`（854）、`section-source.ts`（512）
- `src/figure/freecad-section-geometry.ts`（416）、`freecad-hatch-geometry.ts`（464）、`freecad-structure-script.ts`（734）、`freecad-renderer.ts`（501）、`structure-svg-postprocess.ts`（127）
- `src/tool/add-patent-figure-references.ts`、`src/tool/internal/figure-schemas.ts`（NUMERAL_MAP_SCHEMA）
- `tests/figure-graphviz-ci-signal.spec.ts`（CI 信号守卫）、`tests/figure-{freecad,inkscape,graphviz}-real-render.spec.ts`（真实依赖用例的自跳过语义）
- `src/tool/figure-output.ts`（索引降级但不静默）、`src/figure/leader-line.ts`（退化内嵌 + 警告）
- `src/figure/viz-wasm-renderer.ts`（WASM 同步不可中断的声明与错误归类）

**DSH 规范与决策记录**
- `openspec/specs/patent-figure/{leader-line-numerals,multi-panel-continuation,submission-spec,two-step-analysis,wasm-rendering}/spec.md`
- `.agents/notes/implemented/feature/2026-09-24-patent-team-illustrator-role.md`
- `.agents/notes/implemented/architecture/2026-09-28-inkscape-text-to-path-figure-export.md`
- `.agents/notes/implemented/feature/2026-09-21-patent-drawing-office-profiles-and-vector-figures.md`
- `.agents/notes/implemented/simplification/2026-09-17-figure-tools-shared-bootplate.md`
- `.agents/notes/implemented/feature/2026-08-30-patent-figure-vision-path.md`
- `docs/upgrade-guide/v0.2.0-rc.2/patent-figure-non-svg-export/guide.md`

**本仓**
- `docs/patent-figure-harness-parity-plan.md`（2026-09-22 已完成的对齐及其 §8 延后清单）
- `docs/patent-figure-hardening-plan.md`（核验侧加固 P0–P2）
- `src/patent/figuregen/check-rules.ts`（V1–V21）、`pixel-gate.ts`（PX1–PX4）、`sidecar.ts`、`readback.ts`、`office-profile.ts`、`leader-line.ts`、`cad/`
- `src/patent/atoms/handlers/builtin/figure.ts`（figure-gate）
- `skills/patent-illustrator/SKILL.md`

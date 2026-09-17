# Agent Note: 栅格附图像素级门禁（`patent_figure_check.image_paths`）

Status: implemented

## Problem

本模块的 V 规则吃 `FigureSpec` 或本渲染器产出的 SVG，`readback.ts` 明确声明"外部工具产出的
SVG 不在此契约内" ⇒ **客户扫描件 / CAD 导出 / 他人绘制的栅格图此前零确定性门禁**：黑白性、
线宽、DPI、物理尺寸都只能靠肉眼；而这几项恰恰是形式审查最常挑的（指南一部一章 4.3/4.6：
黑白线条、可清晰分辨）。

`src/patent/figure/preprocess.ts` 已在用 `sharp`（本项目直接依赖），补齐的图像解码能力是现成的。

## Decision

新增 `figuregen/pixel-gate.ts`：`analyzeGrayImage`（纯函数，输入灰度缓冲）+
`analyzeImageBuffer`（sharp 动态导入的解码包装），四条规则（**`PX*` 与 CNIPA 的 `V*` 分列**——
它们不是"细则某条"，而是交付图像的可判质量属性）：

| 规则 | 判据 | 严重度 |
|---|---|---|
| PX1 黑白性 | 中间灰占非白像素比例：> 30% 判 fail，> 5% 判 warn | fail / warn |
| PX2 线宽 | 非白 run-length 的 5% 分位换算打印毫米，再按 2/3 折算；< 0.1mm 判 warn | warn |
| PX3 尺寸/DPI | DPI 超出 72–300，或纸面尺寸超出 A4 可印区（`page-contract` 同源常量） | warn |
| PX4 图号声明 | 栅格侧**不做 OCR**：只核验"是否声明图号"（文件名 `…-fig3.png` / 显式参数） | 未声明 warn / 已声明 info |

接线（D2 决策：走干净替代）：`patent_figure_check` **新增可选属性 `image_paths`**，
`svg_paths` 语义**保持不变**（仍只吃本模块 SVG 回读）。三者可并用；只给 `image_paths` 时
如实声明"结构规则不适用"（skipTextRules + skipLayoutRules），只跑像素门禁。

`inputSchema` 变更 ⇒ 同 PR 重录 `tests/fixtures/llm-replay/deepseek-v4-flash-basic/`
（操作手册见 `docs/patent-figure-hardening-plan.md` §7；本次实操另修正了手册——录制必须用
重放测试 pin 的 provider/model，否则录出的请求键与重放侧不一致）。

## Alternatives considered

- **扩宽既有 `svg_paths` 的语义（让它也吃栅格图）** — 落选（D2 决策即"选干净替代"）：
  `svg_paths` 的契约是"回读本模块 SVG 的 data-ref"，掺入栅格会让"回读失败"与"格式不支持"
  两种情形混在一个错误码里；新增属性让两条路径各自 fail-explicit。
- **不做像素分析，改为提示"请人工确认栅格图合规"** — 落选：那等于维持零门禁；黑白性/线宽/
  DPI 都是**可确定性判定**的，能判而不判是能力缺口而非取舍。
- **引入 OCR 读图号** — 落选（计划 §10 明确不做）：新增 OCR 依赖（体积/离线/中文准确率）
  只为核验一个"图上是否有图号"，而图号本身可由调用方声明；改为"无声明则 warn"的诚实降级。
- **中间灰单级硬判（> 5% 即 fail）** — 落选：扫描件的边缘抗锯齿天然产生灰像素，单级硬判会
  把合法扫描件判死；两级（>30% 阴影/灰度渲染 fail，>5% 需人工确认 warn）区分了"确实灰度化"
  与"可能是扫描灰度"。
- **线宽用最小值而非 5% 分位** — 落选：扫描噪点会给出 1px 的孤立 run，最小值对噪声毫无
  稳健性；5% 分位保留"系统性偏细"的判定能力，并在样本不足（< 20 run）时如实跳过而非硬判。
- **对超大图先降采样再分析** — 落选：降采样会**改变线宽**，正好破坏 PX2 的判据；改为超过
  2500 万像素时跳过像素级核查并说明（诚实降级 > 给出失真结论）。
- **像素发现也纳入 `FigureCheckResult.findings`（复用 V 规则号）** — 落选：V 号对应法规条目，
  把"线宽偏细"挂在某个 V 号下是错误归因；`PX*` 分列并在工具文本中单列一节，让"这是图像质量
  属性、不是条款判据"一眼可辨。

## Consequences

**换来**：栅格/外部来源附图首次有确定性门禁（黑白性、线宽、DPI、尺寸、图号声明），
与 `figure-gate` 的 SVG 路径互补；发现附指标证据（灰度占比、线宽 px 与打印 mm、估算 DPI）。

**付出**：

- `patent_figure_check` 的 `inputSchema` 变更 ⇒ fixture 重录（已完成，见 §7 手册）；
  工具输出新增"栅格附图像素级核查"小节。
- 纯数字阈值（中间灰比例、最小线宽、DPI 区间）是**初值**，未经打印实物验证；它们只出现在
  模块常量与 HITL 报告面，不进工具描述（隐藏清单纪律）。
- 线宽/中线灰判据对**扫描件**有天然不确定性（噪点、扫描分辨率），故 PX1/PX2 的上限设为
  fail 的只有"大面积中间灰"一档，其余为 warn；PX4 未声明图号也是 warn（不阻断）。
- `analyzeImageBuffer` 依赖 `sharp`（已是直接依赖）：解码失败 fail-explicit（不静默跳过），
  与"该图像的核验路径只有这一条"匹配。

## 相关

- 计划：`docs/patent-figure-hardening-plan.md` §4 P1-3（决策 D2）与 §7 重录手册
- 相邻：`docs/notes/implemented/2026-09-17-figure-v7-medium-anchoring.md`（共用 `page-contract` 纸张常量）
- 代码：`src/patent/figuregen/pixel-gate.ts`、`src/tool/builtin/patentFigureCheck.ts`
- 测试：`tests/patent/figuregen/pixel-gate.spec.ts`（纯函数判据 + sharp 现场生成 PNG 的解码路径）、
  `tests/patent/figuregen/tools.spec.ts`（`image_paths` 接线与 `svg_paths` 回归）

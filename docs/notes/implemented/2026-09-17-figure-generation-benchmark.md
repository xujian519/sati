# Agent Note: 附图生成侧合规基准（基线 + 语义锚点的回归护栏）

Status: implemented

## Problem

`docs/patent-figure-hardening-plan.md` §6.2 要求给"渲染器 + 核验器"补回归护栏，因为本轮改动
（P0-4 介质锚定、P1-2 字宽度量、LR 画幅修正）改变的都是**度量与阈值**——这类漂移不会让任何
现有单测变红，只会让 A4 打印稿被分页切断或字高不足时才发现。

现有 `scripts/figure-benchmark/` 只有**分析侧**（`run.ts`）：读 `~/.sati/benchmark/` 的真实客户
附图、调真实模型、与人工 ground truth 比对——数据不入库、CI 无凭据，天然不能当门禁。

## Decision

新增**生成侧**基准（与渲染/核验同为确定性纯函数，无模型、无网络、无私有数据）：

- `scripts/figure-benchmark/gen-cases.ts`：11 个入库用例 / 13 张图。用例按"已修缺陷的回退面"
  构造——8/12/16 步 TB 流程图（介质锚定）、同结构 CJK 与 Latin 长标注（字宽度量）、
  3 节点与 6 节点 LR 方框图（画幅）、同组件两种标注形态（V4 归一化）、括号按面判定（V10/V11）、
  混排画幅（统一缩放）、US 英文文字面（辖区分支 + 分节降级）。
- `scripts/figure-benchmark/gen-compliance.ts`：指标 = 每图纸面毫米 + 是否单独落进 A4 可印区、
  同文档统一缩放系数、缩放后打印字高分布、V 规则命中数（按严重度）、文字面分节覆盖率；
  `collectMetricDrift` 逐字段比对基线并给出漂移路径；`--update` 刷基线。
- `tests/fixtures/patent/figuregen-bench/baseline.json`：入库基线（13 图 / 页内率 0.54 /
  打印字高 1.78–3.70mm / fail 7 · warn 2）。
- `tests/scripts/figure-benchmark/gen-compliance.spec.ts`：① 基线逐项比对；② **语义锚点**——
  超框判定、打印字高 warn、同文档字高一致、V4 不误报、V10/V11 分面、LR 落进可印区、英文标题
  如实声明"未分节"。第 ② 组断言不随基线更新而放宽，防止"刷基线"把真回归洗白。

## Alternatives considered

- **在分析侧 `run.ts` 加 `--gen` 开关复用一套 CLI** — 落选：分析侧依赖私有数据集与真实模型
  凭据，混在一起会让"CI 能否跑"取决于环境；生成侧不需要模型，独立成文件后门禁语义清晰
  （CI 必跑、无凭据也可跑）。
- **只做 CLI 打印、不入库基线** — 落选：没有基线就没有 CI 信号，而 §6.2 明确要的是"回归护栏"。
- **整棵 JSON `deepEqual`** — 落选：失败信息无法指出漂在哪一项；改为 `collectMetricDrift`
  逐字段路径（`cases[2].figures[0].height_mm: 239 → 355`），并在 CLI 与测试里提示刷新方式。
- **基线比较留容差（如 ±0.01mm）** — 落选：渲染是确定性的，容差只会掩盖真实的度量漂移；
  宁可精确比对，把"本次漂移是有意的"作为一次显式的 `--update`。
- **用例改用真实案件抽取的 FigureSpec** — 落选：客户案件不入库（同分析侧纪律），且真实图的
  预期值需要人工标注意见；用例按回退面手工构造后入库，评审时能一眼看出每例在防什么。
- **把基准挂进 `pnpm lint` 聚合门禁** — 落选：同一断言已由 `pnpm test` 中的 spec 覆盖，
  重复挂接只增加门禁时长；`--update` 与人工诊断仍走 CLI。

## Consequences

**换来**：度量/阈值类改动有了可复算的比对对象——漂移在本地与 CI 都会被指出来（哪一例、哪一项、
从多少到多少）；同时把"当前语义"（V 规则命中分布、页内率、字高区间）落成可评审的数字。

**付出**：

- 新增维护点：改渲染度量或 V 规则后必须 `--update` 并说明理由（不更新即红）。
- 基线是**确定性快照**而非质量结论：它记录现状（含 7 条 fail finding），不表示现状已达标；
  真正的质量目标仍在 HITL 报告与计划文档里。
- 用例是构造数据，不覆盖真实扫描件/外部 CAD 的畸变（那一面由分析侧基准 + 像素门禁覆盖）。
- 指标口径（页内率 = 单图独立落进可印区；字高按同文档统一缩放）写在 `gen-compliance.ts`
  头部，改动口径即等于改基线语义，须同步更新本条 note。

## 相关

- 计划：`docs/patent-figure-hardening-plan.md` §6.2（评测扩展）与 §8（验收总表）
- 相邻：`docs/notes/implemented/2026-09-17-figure-v7-medium-anchoring.md`（介质锚定的阈值来源）、
  `2026-09-17-figure-text-metrics.md`（字宽按字符类别度量）、
  `2026-09-17-figure-lr-layout-frame.md`（本基准发现并修复的 LR 画幅缺陷）
- 代码：`scripts/figure-benchmark/gen-cases.ts`、`scripts/figure-benchmark/gen-compliance.ts`
- 基线：`tests/fixtures/patent/figuregen-bench/baseline.json`
- 测试：`tests/scripts/figure-benchmark/gen-compliance.spec.ts`

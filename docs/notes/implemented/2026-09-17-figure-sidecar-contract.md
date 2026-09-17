# Agent Note: 附图产物 sidecar（`<name>-figures.json` v1 契约）

Status: implemented

## Problem

附图的核验输入有两样，而它们在时间上是分离的：

- **FigureSpec**（V1/V4/V5/V7/V8/V9）——生成时就有；
- **说明书文本**（V2/V3）——要到说明书定稿（`draft_spec`）之后才有。

`patent_figure_generate` 在生成期只能以 `skipTextRules: true` 跑结构规则，定稿后要重跑
全量规则就得**重新提供全部 spec**。而工作流阶段（`figure_generate`）是透传的：主代理只能
把文件路径写进阶段文本，下游拿不到结构化 spec，于是"定稿后重核"实际不可达——核验从未被
自动执行（同 PR 的 figure-gate 也是因缺这个输入契约才无从接线）。

## Decision

`patent_figure_generate` 与 SVG 同目录落盘 `<output_name>-figures.json`（v1）：

```json
{ "version": 1, "generated_at": "…", "output_name": "…", "renderer": "builtin",
  "jurisdiction": "cn", "document_kind": "utility",
  "check": { "stage": "generation", "skip_text_rules": true, "ok": true, "findings": [] },
  "figures": [ { "figure_no": 1, "file": "…-fig1.svg", "spec": { …FigureSpec… } } ] }
```

三处刻意的选择：

1. **`file` 存文件名而非绝对路径**：sidecar 与图由同一工具在同一目录成对产出，相对解析让
   案卷整目录搬迁（改工作目录/换机器）后仍可用，也不把家目录写进案卷产物。
2. **findings 只有一份**（顶层 `check`），不按图拆分：finding 自带 `figure_nos`
   （V1/V2/V3/V8/V9 本就是集合级判定），按图复制会制造两份真相。
3. **解析 fail-loud**：`parseFigureSidecar` 校验 version / `figures[].file` / `spec.nodes`，
   手工改坏的 sidecar 报错而非被当作"空附图集"静默通过（核验器的假通过比报错危险）。

`generated_at` 是审计字段，**不参与任何判定**——不引入新的非确定性判定源。

## Alternatives considered

- **把 spec 内联进 SVG（注释/`data-spec` 属性）** — 落选：SVG 是交付物，会被代理师/第三方
  工具改写（改颜色、改布局）后仍声称"合规"；sidecar 与 SVG 分离才能做"回读自检 + 漂移
  fail-loud"（gate 用 `spec` 判规则、用 `file` 的文件回读 `data-ref` 互验）。
- **复用工作流阶段的文本通道（让主代理把 spec JSON 写进阶段文本）** — 落选：那要求模型
  逐字复述一段它没有理由记住的 JSON，既不可靠（截断/改写）也不是结构化契约；阶段文本的
  用途是给人看的摘要。
- **落盘到 transcript 或 `.sati/` 全局目录而非案卷输出目录** — 落选：附图与其他案卷产物
  （`data/cases/<id>/outputs`）必须同址——搬迁/归档案卷时产物是一体的；transcript 侧还会
  被压缩/裁剪，且子代理与 resume 路径都要额外接线。
- **绝对路径 + 文件名双写** — 落选：两份路径即两个真相源，解析时要决定"以谁为准"；案卷
  内产物天然同目录，文件名足够且不泄漏家目录路径。
- **sidecar 里附带每幅图的 check 结果** — 落选（见 Decision 2）：会复制集合级 finding，
  且"每图 ok"的语义含糊（V1 说的是整个图集的编号连续性）。
- **把 sidecar 做成通用"附图清单"并顺带记录源文件 hash / 修订号** — 落选（本次不做）：
  需要定义"何时算漂移"（重新渲染？手工编辑？），而漂移判定已由 gate 的 `data-ref` 回读
  自检覆盖；先只记录可判定的最小事实。

## Consequences

**换来**：定稿期可在**有说明书文本**时零信息损耗重跑全部规则（V2/V3 从此可达）；附图门禁
（figure-gate）有了确定性的输入契约；案卷产物自描述（谁产、什么渲染器、哪一辖区、生成期
结构核验结论）。

**付出**：

- 案卷输出目录新增一个文件（`<name>-figures.json`），工具 result 的 file 块由 1 个变 2 个
  （format=both 时 3 个）——既有按块计数/按目录枚举的消费方需适配（已在同 PR 的测试中同步）。
- sidecar 与 SVG 可能不同步（手工改 SVG 不同步改 sidecar）：由 gate 的 `data-ref` 回读自检
  覆盖为 fail-loud，但**仅在被 gate 消费时**才检测到。
- sidecar 含 `generated_at`，故同一输入的两次落盘**不逐字节相同**（与 SVG 的确定性纪律不同，
  这是有意的：审计字段）。
- v1 契约的演进需升 `version` 并同步 `parseFigureSidecar`（已 fail-loud，不会静默误读）。

## 相关

- 计划：`docs/patent-figure-hardening-plan.md` §3 P0-2（消费方 P0-3 figure-gate）
- 代码：`src/patent/figuregen/sidecar.ts`、`src/tool/builtin/patentFigureGenerate.ts`
- 测试：`tests/patent/figuregen/sidecar.spec.ts`、`tests/patent/figuregen/tools.spec.ts`

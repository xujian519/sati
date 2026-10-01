# Agent Note: 附图门禁接进栅格像素核验与输出契约

Status: implemented

## Problem

两处「核验能力已存在、但没有接进它本该守的位置」的接线缺口（与 deepseek-harness 的对照分析见 `docs/research/patent-figure-dsh-delta-2026-10.md` §4 P0-7）：

1. **像素门禁的 fail 不参与阻断**。`figure-gate` 是交付前最后一道自动门，但它的 fail 判定只统计 `checkFigures` 的结构化发现；`pixel-gate`（PX1 黑白性 / PX2 线宽 / PX3 尺寸与 DPI / PX4 图号声明）只被 `patent_figure_check` 按需导入。后果：PX1「中间灰占非白像素 > 30%」（灰度或着色渲染的代理指标）这类严重缺陷只在**有人主动调工具时**的报告里出现，从不中断流程——与「把核验接成工作流门禁」的既有设计意图相悖。

2. **三个制图工具的 `outputSchema` 是空壳**。`patent_figure_generate` / `patent_figure_check` / `patent_figure_project` 都声明 `{type:"object",properties:{}}` 且 `execute` 只返回 `content`、不返回 `data`。而 `ToolRuntime` 的输出校验前置条件是 `output.data !== undefined` ⇒ 三个工具的输出契约**从未生效过一次**，尽管 registry 开着 `requireOutputSchema: true`（那只在「已声明」层面自洽）。

附带发现一处会留半成品目录的入参校验时序问题：`patent_figure_generate` 的 `format` 合法性检查位于 SVGs 与 sidecar **都已落盘之后**，非法 `format` 会先写出一个半成品输出目录再抛错。

## Decision

1. `figure-gate` 在 sidecar 同目录按**本案命名体例** `<output_name>-fig<N>.<ext>`（png/jpg/jpeg/webp/gif/tif/tiff）发现栅格附件，逐张跑 `analyzeImageBuffer`，其 fail 级发现与结构规则发现**同权**参与 `InterruptStageError` 判定；报告单列「栅格附图像素级核验」段，`figure-check.json` 增可选 `raster` 字段留痕。
   - **按命名体例而非「目录下全部图片」**：案卷目录常混有无关图片（客户对比材料、他案扫描件），全量纳入会制造误报与错误阻断。
   - **解码不可用（sharp 未装 / 格式不支持）时逐图记录失败原因**，报告写明「该图因此缺少黑白性/线宽/DPI 核验」，但**不**计入 fail。本机缺解码器不是申请人的过错，不该阻断交付；沉默跳过则是假保证。
   - 栅格附件字节（sha256）**并入** `inputs_hash`；**无附件时不并入** ⇒ 纯矢量案件的哈希值与既有契约逐字节一致，既有断言不震荡。
2. 三个制图工具补真实 `outputSchema` 并返回 canonical `data`；共用的输出片段（发现、产物、像素条目）单点定义在 `src/tool/builtin/patentFigureSchema.ts`，避免同一份附图数据在三处各自漂移。
3. `patent_figure_generate` 的 `format` 校验前移到落盘之前，与其他入参校验集中。

**零 `inputSchema` 变更**（`FIGURE_FINDING_SCHEMA` 等只被 `outputSchema` 引用）⇒ 不触发 llm-replay fixture 重录。

## Alternatives considered

- **把像素结论经 gate 的入参通道传入**（报告里列的另一种落点）——`StageHandler` 契约没有额外输入通道，要加就得动 manifest 阶段参数；门自行发现附件的成本更低且不需要调用方配合。
- **扫目录下全部图片**（不按命名体例过滤）——会把无关图片卷进判定与阻断；`CaseOutcomes` 目录里出现客户提供的对比图是常态。
- **解码失败直接判 fail**——会把「本机没装 sharp」变成「附图违规」，是错误归因；但也不静默（记 `未核验栅格=N` 与逐图原因）。
- **只对 `image_paths` 显式声明过的栅格图跑门禁**——`figure-gate` 拿不到工具调用的入参，只能看磁盘；且「没声明就不核验」会让遗忘声明成为绕过门禁的路径。
- **先只补 `outputSchema`、暂不返回 `data`**——那样契约仍是空转（校验前置条件不满足），等于把空壳留成「看起来有契约」；两者必须同批。
- **`outputSchema` 用宽松的 `additionalProperties: true`**——契约要能挡住字段漂移；代价是将来加字段必须同步改 schema，这是有意的摩擦。
- **把栅格哈希也塞进既有 `inputs_hash` 的固定键**（无论有无附件都写入空数组）——会改变所有纯矢量案件的哈希值、冲击既有断言，而输入实际没变。

## Consequences

换来：PX 级缺陷第一次真正能中断流程；栅格附图的核验结论可审计（`figure-check.json` 的 `raster` 段 + `inputs_hash` 覆盖附件字节）；三个工具的输出首次受机器校验，字段漂移会在**注册即用**时暴露而不是被消费方默默容忍；非法 `format` 不再留半成品目录。

付出：`figure-gate` 新增磁盘 IO 与图像解码（仅当存在栅格附件；超过 `PIXEL_MAX_ANALYZE_PIXELS` 会自动跳过并说明）；`additionalProperties: false` 让三个工具的输出契约此后必须显式演进；`figure-check.json` v1 内新增可选字段（无读取方的解析校验，故不升版本）。

一处**测试质量**问题的修正：`tests/patent/figure-gate.spec.ts` 的「原子契约」用例原先把本地新建的字面量与自身 `deepEqual`（声称校验「描述不含阈值数字」，实际从未触碰真实原子，零检测力），已改为断言真实 `figureGateAtom` 的键位与描述。需要澄清的是：**「描述不含阈值数字」这条纪律本身一直有真护栏**——`tests/patent/drafting-sop.spec.ts` 的「隐藏清单」用例对真实原子与 manifest 阶段描述做正则断言。原用例的问题是多了一处看起来在守、实际没守的重复，而非纪律无人守。

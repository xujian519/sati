# 多模态「按需路由 + 提示词精修」最小落地方案（MVP）

> 状态：✅ 已实施（见文末「实施记录」）| 范围：router 层媒体路由配置 + 附图提示词精修 + 降级/审计 | 实际投入：5 步全部完成
> 依据：M-Cube 深度研究（`deepresearch-output/mcube-multimodal-vs-sati.md`）阶段一决策 + 本方案审计结论
> 原则：不动外部协议契约、不破坏确定性系统、可随时回滚、先让现有图能力被充分使用

**v2 修订说明**（对照 v1 审计，详见文末附录）：
- v1「模块一：新建 `vision-routing.ts` 纯函数 + ModelRuntime 接线」**已废弃**——审计发现 Sati Router 层已实现媒体感知路由（`rerouteDecisionForMedia`），v1 是重复建设且落错层。
- 本文档模块一改为 **router 层配置 + fallback 语义审计**。

---

## 1. 背景与目标

Sati 已具备附图能力（`src/patent/figure/`）与**媒体感知路由机制**（`src/router/`），但存在三个短板：

1. **媒体路由未生效**：`rerouteDecisionForMedia`（`src/router/RouterRuntime.ts:156`）已能从 messages 收集 image 需求、检查模型能力、在 fallback 候选里找视觉模型，但**默认配置（`bootstrap-sati-config.mjs`）的 `router.fallback` 是 `_placeholder`**，导致实际行为是"找不到视觉候选 → 降级为文本占位符"。
2. **提示词未充分吸取领域经验**：M-Cube / PatentLMM 验证的指令粒度（图面证据粒度、标号谨慎规则、JSON 安全约束）未完全落地。
3. **JSON 解析失败即降级**：`callStep` 用 `tryParseJson` + 重试，失败直接降级，缺"带 schema 让模型自修复"一层（M-Cube PR#8 验证的有效手段）。

**目标**：最小改动让"任何含图请求自动获得视觉模型"真正生效 + 提升附图分析质量 + 失败可审计可降级。

**不做**（第二阶段）：OCR 注入、现有技术附图对比工具、graph 域视觉接入、旋转归一化。

---

## 2. 架构总览（现状 + 缺口）

```
请求 messages 含 image 块
        │
        ▼
RouterRuntime.decide()
  ├ 决策（scenario / tokenSaver / custom / explicit）→ decision.provider/model
  ├ ★ rerouteDecisionForMedia(decision, messages, mutations)   [RouterRuntime.ts:478 已调用]
  │     required = collectRequiredInputModalities(messages)     [已实现，含 tool_result 子块]
  │     若 decision 模型 supportsMediaRequirements → 不动
  │     否则 findCompatibleFallback(scenarioType, required)      [在 router.fallback 里找]
  │       ├ 找到 → 替换 decision + 记录 mediaCapabilityRerouted  [已暴露到 sati_router_decision 事件]
  │       └ 找不到 → 不路由（↓ 落到降级）
  └ 决策定稿 → streamAttempt
        │
        ▼
downgradeRequestForAttempt  [RouterRuntime.ts:1082]
  └ downgradeUnsupportedContent(messages, multimodal)  → 图变 [Image: … omitted] 文本占位符
```

**核心结论：路由与降级的代码 100% 已存在，缺的是「视觉模型配置进 fallback」这一步。** 本方案不再写路由代码。

---

## 3. 模块一：媒体路由（配置 + 语义审计）

### 3.1 现状清单（无需新增代码）

| 能力 | 位置 | 状态 |
|---|---|---|
| 收集媒体需求（含 tool_result 内嵌 image）| `src/router/utils/mediaRequirements.ts` `collectRequiredInputModalities` | ✅ |
| 判断模型是否支持 | `missingInputModalities` / `supportsRequiredModalities` | ✅ |
| 媒体感知重路由 | `RouterRuntime.ts:156` `rerouteDecisionForMedia` | ✅ |
| 路由结果审计 | `decision.mutations.mediaCapabilityRerouted` → `sati_router_decision` 事件 | ✅（需确认消费者读取）|
| 降级（找不到视觉模型时）| `RouterRuntime.ts:1082` `downgradeRequestForAttempt` | ✅ |
| 测试 | `tests/router/utils/mediaRequirements.spec.ts`（8 用例）| ✅ |

### 3.2 真正缺口：fallback 语义混用（审计发现 3）

`RouterFallbackConfig`（`src/router/config/schema.ts:65`）一个结构承担两个职责：

```
router.fallback:
  default:    [m1, m2]      ← ① 故障降级链（planFallback 顺序尝试，isFallbackEligible 过滤错误）
  subagent:   [m3]
  explicit:   [m4]
                              ← ② 媒体升级候选（findCompatibleFallback .find 第一个支持 image 的）
```

**风险**：
1. **成本陷阱**：视觉模型（kimi-k3 thinking，贵）放进 fallback 后，主模型 `billing`/`model_not_found` 失败时会被当作故障降级目标尝试，成本激增。
2. **顺序竞争**：媒体重路由 `.find` 与故障降级"顺序尝试"对同一数组有不同消费方式，候选顺序不可预测。
3. **场景错位**：媒体升级是跨场景横向需求，fallback 是纵向故障链；`findCompatibleFallback(decision.scenarioType)` 按场景取候选，若只配 `default`，subagent/explicit 场景含图时找不到视觉模型。

### 3.3 方案：先「配置约定」（MVP），数据驱动再「拆键」

**Phase A（本方案，零代码，0.5 人日）——配置约定：**

```yaml
router:
  fallback:
    default:
      - _placeholder/_placeholder   # 主文本模型（保持）
      - moonshot/kimi-k3            # ← 视觉候选，放在数组末尾
```

约定与配套动作：
- 视觉模型**置于 fallback 数组末尾**，使故障降级时它作为最后兜底（前序文本模型失败才会轮到它），媒体重路由 `.find` 仍能命中它
- 在 `bootstrap-sati-config.mjs` 注释中警示："视觉模型若加入 fallback，请置于末尾；故障降级会顺序尝试该链，视觉模型调用成本显著更高"
- 观察 `sati_router_decision` 事件的 `mediaCapabilityRerouted` 频率与 `sati_router_fallback` 事件是否意外落到视觉模型

**Phase B（后续，数据驱动，0.5-1 人日）——若成本陷阱真实发生，拆 `fallback.media` 键：**

在 `RouterFallbackConfig` 增加独立键 `media`（跨场景视觉候选，与 `default/subagent/explicit` 并列，处理方式类比现有 `maxFallbacks` 特殊键）：

```ts
// schema.ts
export type RouterFallbackConfig = Partial<Record<RouterScenarioType, RouterModelRef[]>> & {
  maxFallbacks?: number;
  media?: RouterModelRef[];   // 新增：跨场景媒体能力候选
};
```

```yaml
router:
  fallback:
    media: [moonshot/kimi-k3]   # 语义清晰：仅用于媒体升级，不参与故障降级
```

配套改动（`parseRouterConfig.ts` `parseFallback` 加 `media` 键解析；`RouterRuntime.ts` `findCompatibleFallback` 优先读 `fallback.media`）：
- `media` 键**不进入** `planFallback` 的故障降级链
- `findCompatibleFallback` 改为：先查 `fallback.media`，再查 `fallback[scenarioType]`/`fallback.default`

**决策依据**：`RouterScenarioType` 仅 3 个键（default/subagent/explicit），顶层新配置过度设计；`media` 键拆分的改动集中且语义清晰。MVP 阶段先零代码验证"配置即可用"，避免为未发生的成本陷阱提前写代码。

### 3.4 审计链补全（0.5 人日）

`mediaCapabilityRerouted` 已随 `sati_router_decision` 事件暴露（`events.ts` 的 `RouterDecisionEvent.decision.mutations`）。补全动作：
- 确认 telemetry / 日志消费者是否读取 `mutations.mediaCapabilityRerouted`；若未读取，在 `src/telemetry/` 的 router 事件消费处补一条结构化日志（不新增事件类型）
- 输出字段：`required` / `from` / `to`（已有），供第二阶段数据收集

---

## 4. 模块二：提示词精修（保留 v1，含 1 处措辞修正）

### 4.1 现状（`src/patent/figure/prompts.ts`）

已有 `FIGURE_SPEC_GUIDE`、`formatContext`（claim_context 4000 字符截断）、Step1/Step2/Step3 schema、按 figureType 自适应。缺：标号谨慎规则、图面证据粒度、旋转/模糊提示、JSON 安全约束。

### 4.2 改动点

**A. `FIGURE_SPEC_GUIDE` 追加 2 条**（作用于全部 Step，注意与现有 U1/U2 机制区分——见措辞修正）：

```
"标号识别必须严格依据图面：图面可见但标号模糊、被遮挡或无法确认的部件，不得臆造编号或用近似编号代替，应在结果中明确注明'无法确认'；仅当部件在图面确实无标号时，才使用 U1/U2… 占位符并注明。",
"组件描述应包含图面可见的物理形态、空间相对位置与连接关系（如'安装于支架左侧、经连接轴与驱动轮相连'）；图面未显示的信息不得补充。",
```

> **措辞修正（审计发现 9）**：原 v1 文案"禁止猜测或用近似编号代替"未区分「标号模糊」与「部件无标号」两种情形。上文案显式区分，避免模型把"无标号部件"误当"无法确认"处理，导致现有 U1/U2 占位符机制失效。

**B. Step1 任务扩展**（`buildStep1Prompt`）：

```
"3. 若图面存在旋转（横向/竖向）、模糊、多图拼版或明显无法识别的区域，在 notes 中逐条说明。",
```

**C. Step2 组件描述粒度**（`buildStep2Prompt`）：

```
"每个组件的 description 必须包含图面可见的结构细节：形状、位置、与相邻部件的连接方式；仅当图面确实可见时书写，图面未展示的内容（如材料、参数）不得补充。",
```

**D. JSON 安全约束**（Step1/Step2 尾部统一）：

```
"只输出一个 JSON 对象；不要用 markdown 代码围栏；不要输出 JSON 以外的任何文字；所有键与字符串使用双引号。",
```

### 4.3 JSON 自愈（`src/patent/figure/analyze.ts` `callStep`）

现状：`tryParseJson` 失败 → 重试 → 降级。新增**一次**模型自修复调用（含审计发现 7 修正）：

```ts
/**
 * 构建修复请求。与 buildRequest 不同：
 * - 不附带图片 base64（纯文本 JSON 修复即可，避免重复传输图片、成本翻倍）
 * - metadata.phase 使用 "repair:<step1|step2>"，与正常 step1/step2 区分（测试/追踪判别）
 */
function buildRepairRequest(input, repairPrompt, opts): CanonicalModelRequest {
  return {
    provider: opts.provider,
    model: opts.modelId,
    messages: [{ role: "user", content: [{ type: "text", text: repairPrompt }] }],  // 无 image 块
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    stream: true,
    metadata: { tool: "analyze_patent_figure", phase: `repair:${opts.phase}` },
  };
}

// callStep 内，tryParseJson 失败且重试耗尽后：
const repaired = await collectModelText(model, buildRepairRequest(input, buildRepairPrompt(STEP1_SCHEMA, raw, "step1"), opts), opts.signal);
if (tryParseJson(repaired) !== undefined) return { ok: true, raw: repaired };
```

- **只触发一次**（不进入重试循环），修复仍失败 → 走既有降级路径
- `buildRepairPrompt` 带 schema + 原始输出 + 解析错误 + phase（同 v1）

---

## 5. 模块三：降级与审计（修正：复用 router 现有 mutation）

### 5.1 媒体路由审计（复用现有机制，非新建）

- 路由审计 = `decision.mutations.mediaCapabilityRerouted`（已有，含 required/from/to），随 `sati_router_decision` 事件暴露
- 本方案仅补：确认 telemetry 消费者读取该字段（见 3.4）
- **不再新建 `onVisionRoute` 回调**（v1 的 ModelRuntime 接线已随架构修正废弃）

### 5.2 附图分析审计（`src/tool/builtin/analyzePatentFigure.ts`）

- 现状 metadata：`figureType` / `componentCount` / `usable` / `indexed`
- 扩展（向后兼容，optional）：

```ts
metadata: {
  domain: "patent",
  figureType: result.figureType,
  componentCount: result.components.length,
  usable: result.usable,
  indexed,
  modelUsed: result.modelUsed,          // result 已有，提升到 metadata 便于审计
  imageBytes: prepared.bytes,           // 注入图片字节数（压缩后字节，成本追踪）
  visionWarnings: result.warnings.length, // 降级/告警计数
},
```

### 5.3 降级语义确认（不改逻辑）

- `FigureAnalysisResult.usable`（组件数 > 0 且置信度 ≥ 0.6）已提供"是否需人工确认"语义
- `analyze.ts` 已有"解析失败降级返回而非报错"——本方案保持

---

## 6. 测试计划

### 6.1 router 层测试（`tests/router/utils/mediaRequirements.spec.ts` 已有，扩展）

| # | 场景 | 断言 |
|---|---|---|
| 1 | 无媒体块 | 空数组（已有）|
| 2 | tool_result 内嵌 image 被收集 | 已覆盖 |
| 3 | **新增**：`rerouteDecisionForMedia` 命中 fallback 视觉模型 | decision.provider/model 被替换，mutation `mediaCapabilityRerouted` 含正确 from/to/required |
| 4 | **新增**：fallback 无可支持候选 | decision 不变，mutation 无 `mediaCapabilityRerouted` |
| 5 | **新增**：`fallback.media` 键优先于 `fallback.default`（若实施 Phase B）| 命中 media 键候选 |

> 说明（审计发现 8 修正）：v1 的"场景 6 断言 downgrade 生效"已删除——`downgradeUnsupportedContent` 在 router 层 `downgradeRequestForAttempt`，由 router 测试覆盖，而非 model 层单测。

### 6.2 `tests/patent/figure/prompts.spec.ts`（新增）

- `FIGURE_SPEC_GUIDE` 含"不得臆造标号"且**显式区分 U1/U2 占位符机制**（发现 9）
- `buildStep1Prompt` 含旋转/模糊 notes 指令
- `buildStep2Prompt` 含"形状、位置、连接方式"粒度指令
- JSON 安全约束文案存在

### 6.3 `tests/patent/figure/analyze.spec.ts`（扩展）

- mock 模型第一次返回坏 JSON → 修复调用返回好 JSON → 走修复结果
- 断言修复请求**无 image 块**、`metadata.phase` 前缀为 `repair:`（发现 7）
- mock 模型修复也返回坏 JSON → 走既有降级（warnings + usable=false）

### 6.4 工具层测试：`analyzePatentFigure` metadata 新字段断言

---

## 7. 实施顺序与验收

### 7.1 顺序（每步独立提交、可回滚）

| 步骤 | 内容 | 人日 | 提交类型 |
|---|---|---|---|
| 1 | 配置：fallback 加视觉模型 + bootstrap 注释警示（Phase A）| 0.5 | chore(config) |
| 2 | 审计补全：telemetry 读取 `mediaCapabilityRerouted` + router 层测试（6.1 的 3/4）| 0.5 | feat(router) |
| 3 | 提示词精修（A/B/C/D，含措辞修正）+ prompts 测试 | 0.5 | feat(patent) |
| 4 | JSON 自愈（不附图片 + repair phase 标记）+ 测试 | 0.5 | feat(patent) |
| 5 | 工具 metadata 审计字段 + 测试 | 0.5 | feat(patent) |

### 7.2 验收标准

1. `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` 全绿
2. 含图请求经 router 命中视觉模型，`sati_router_decision` 事件携带 `mediaCapabilityRerouted`（mock 验证）
3. 纯文本请求行为与现状一致（回归重点——路由逻辑未改，仅配置变化）
4. `analyze_patent_figure` 输出结构不变（`FigureAnalysisResult` 未改，仅 tool metadata 增补）
5. JSON 修复请求不含 image 块（成本约束验证）

---

## 8. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 视觉模型成本（kimi-k3 thinking）| 🟡 | Phase A 配置约定：视觉模型置 fallback 末尾；观察 `sati_router_fallback` 是否意外落到视觉模型；成本陷阱真实发生 → Phase B 拆 `media` 键 |
| fallback 语义混用引发误解 | 🟡 | 文档 + bootstrap 注释警示；Phase B 拆键为升级路径 |
| 提示词改动影响既有输出 | 🟡 | 均为追加式指令（不删现有约束）；figure 域测试覆盖 |
| JSON 自愈增加一次调用 | 🟢 | 仅解析失败路径触发一次；修复请求无图（成本低）；失败走既有降级 |

**回滚**：配置回滚 = 移除 fallback 里的视觉模型；代码回滚 = revert 对应 commit（每步独立）。

---

## 9. 第二阶段（数据驱动）

本方案上线后收集：
1. `mediaCapabilityRerouted` 触发频率、`from → to` 分布（媒体路由使用率）
2. `sati_router_fallback` 是否意外落到视觉模型（成本陷阱信号，触发 Phase B）
3. 附图分析 `usable=false` 比例、warnings 分布（标号无法确认 / 解析失败）

若"标号无法确认"占比高 → 优先 OCR 注入（R4）；若现有技术对比需求高频 → 上 R1。**先让系统用起来，让失败说话。**

---

## 10. 实施记录（2026 年）

### 交付状态

| 步骤 | 方案内容 | 实际改动 | 状态 |
|---|---|---|---|
| 1 | fallback 配置注释警示 | `scripts/bootstrap-sati-config.mjs` +10 行注释（含「置末尾」约定 + events.jsonl 审计说明）| ✅ |
| 2 | 补 router 层测试 | **提取 `resolveMediaReroute` 纯函数**（`src/router/utils/mediaReroute.ts` 新建）+ `RouterRuntime.ts` 改造 + 删除死代码 `findCompatibleFallback` + 6 场景测试 | ✅ |
| 3 | 提示词精修 | `prompts.ts`：`FIGURE_SPEC_GUIDE` +2 条、Step1 旋转/模糊指令、Step2 描述粒度、JSON 安全约束 ×3 + 5 断言测试 | ✅ |
| 4 | JSON 自愈 | `analyze.ts`：`callStep` 加 schema 参数 + 修复请求（不附图片 + `repair:` phase 标记）+ 2 测试 | ✅ |
| 5 | metadata 审计字段 | `analyzePatentFigure.ts` +`modelUsed`/`imageBytes`/`visionWarnings` 三字段 | ✅ |

### 与方案的差异（实施时发现的修正）

1. **步骤 2 需重构而非仅测试**：`rerouteDecisionForMedia` 是 RouterRuntime 内部闭包，不可直接单测。实际提取为纯函数 `resolveMediaReroute`，并顺带删除失去调用方的死代码 `findCompatibleFallback`——比方案 6.1「补测试」多一步重构，但符合 `router/utils/` 纯函数 + 测试的既有模式。
2. **3.4 审计链补全无需代码**：实际核实发现 `sati_router_decision` 事件（含 `mediaCapabilityRerouted`）已由 `buildRouterEventBus`（`src/cli/createLocalGateway.ts:604`）持久化到 `~/.sati/router/events.jsonl`，审计数据已落盘，无需方案 3.4 预想的「补 telemetry 结构化日志」。

### 验证证据

- `pnpm typecheck` ✅ 全绿
- `pnpm build` ✅ 编译 + 资源拷贝
- `pnpm test` 全量 ✅ **2515 pass / 0 fail / 3 skipped**（3 个 skipped 为预存在的环境条件跳过，见 knowledge 法律库/FTS5 检测）
- `eslint`（改动文件）✅ 无告警
- `biome check`（改动文件）✅ 无格式错误

### 待办（数据驱动第二阶段）

- **Phase B**（拆 `fallback.media` 键）：待 `sati_router_fallback` 事件显示视觉模型被故障降级误用后触发
- **R4 OCR 注入 / R1 现有技术图对比**：待 `mediaCapabilityRerouted` 触发频率与 `usable=false`/warnings 分布数据支持后再决策

---

## 附录：v1 → v2 审计修订对照

| # | 审计发现 | v1 问题 | v2 处理 |
|---|---|---|---|
| 1 | Router 层已实现媒体路由 | 新建 vision-routing.ts 重复建设 | 模块一改为配置 + 语义审计 |
| 2 | 真正缺口是配置 | 写路由代码 | 配置视觉模型进 fallback |
| 3 | fallback 语义混用 | 未识别 | Phase A 约定 + Phase B 拆 `media` 键 |
| 4 | downgrade 在 router 层 | 假设在 streamModel | 架构图修正 |
| 5 | spread 覆盖 bug | ModelRuntime 接线 `{...options,...callOptions}` | 废弃该接线，bug 消除 |
| 6 | countImageBlocks 新建重复 | 拟新建 | 复用 `collectRequiredInputModalities` |
| 7 | JSON 修复附图片成本 | buildRequest 复用附图 | 修复请求不附图片 + phase 标记 |
| 8 | 测试场景 6 断言位置错 | model 层测 downgrade | 移到 router 层测试 |
| 9 | 标号措辞与 U1/U2 冲突 | 措辞未区分 | 显式区分"模糊"vs"无标号" |
| 10 | thinking 模型成本 | enabled 默认 false | 视觉模型置 fallback 末尾 + 数据驱动拆键 |

---

*关联文档：`deepresearch-output/mcube-multimodal-vs-sati.md`（研究依据）；代码位置：`src/router/`、`src/patent/figure/`、`src/tool/builtin/analyzePatentFigure.ts`、`scripts/bootstrap-sati-config.mjs`。*

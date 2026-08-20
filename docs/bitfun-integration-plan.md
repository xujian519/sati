# BitFun 优秀设计引入方案（修订版）—— 文书排版实时调参面板 + KV Cache 无损稳定

- 创建日期：2026-08-20（v1）；2026-08-20（v2 修订，对齐三点反馈）
- 状态：**方案评审稿（未实施）**
- 上游：BitFun（`GCWing/BitFun`）「Agentic Mini App」与「KV Cache 前缀字节稳定」两项能力深挖

---

## 0. 修订说明（对齐用户三点反馈）

| # | 用户反馈 | 本版调整 |
|---|---|---|
| 1 | 高频场景是**权利要求书/说明书撰写、意见答复** | Mini App 场景从「Claim Chart 展示面板」**重定位为「HTML 文书排版实时调参面板」**，优先落地 `claims-spec`（权利要求书+说明书）、`oa-response`（意见答复）两个模板 |
| 2 | **专利执行质量必须不降低** | 方案一（排版面板）纯渲染后处理，不碰模型、不碰生成内容；方案二（KV Cache）**降级为「无损字节稳定 + 度量补全」**，明确「不移动任何语义内容」 |
| 3 | 痛点 = HTML 排版凭个人喜好/事务所规定、**模板定死** | 直击该痛点：把排版尺度参数化 + 提供「生成时实时调整 + 实时预览 + 样式预设持久化」 |

---

## 1. 痛点根因（已逐文件核实）

Sati 的专利文书渲染链路现状（`src/patent/document/`）：

```
theme.json (documents.patent) ──► brandInjector.ts (BRAND_KEY_TO_CSS_VAR 映射)
   ──► buildBrandStyle() 编译 CSS 变量 ──► 注入模板 <head> 覆盖 --sati-doc-*
   ──► 模板 :root { --doc-*: var(--sati-doc-*, fallback) } ──► 排版生效
```

**「排版定死」有两层根因：**

1. **排版尺度未 token 化**：颜色、字体、页边距已走 `--sati-doc-*` 变量（可配）；但**字号、行距、段落间距是硬编码**在各模板 `<style>` 里的数字——`html { font-size: 12pt }`、`body { line-height: 1.7 }`、`.doc-header { font-size: 9.5pt }`、`.doc-masthead h1 { font-size: 16pt }`、`.doc-meta { font-size: 11pt }`。`tokens.css` 虽定义了 `--sati-doc-text-*`/`--sati-doc-leading-*`/`--sati-doc-section-gap*`，但**模板没有引用它们**（历史遗留不一致）。

2. **无交互 + 无持久化**：`brandInjector.ts` 的 `BRAND_KEY_TO_CSS_VAR` 映射表**只覆盖「颜色 + 字体 + 文案」三类**（firm/confidential/accent/body/muted/border/…/fontSerif/fontSans/fontMono），**没有暴露字号/行距/间距/页边距**；且 theme.json 是静态配置文件（注释「待 PilotConfig.brand 贡献点就绪后读取」），改一次要重跑，不能「生成时实时调整」。事务所的「样式规定」也无法沉淀为可复用预设。

**结论**：这是 Mini App 的完美适用场景——一个「排版参数表单 + 实时预览」的调参面板，且**纯渲染后处理、零模型质量风险**。

---

## 2. 方案一：HTML 文书排版实时调参面板（Style Panel）【P0】

### 2.1 设计目标

- 生成 `claims-spec` / `oa-response`（后续扩展到其余三模板）文书时，代理人可**实时调整排版参数并即时预览**，满意后「锁定导出」HTML/PDF。
- 调整结果可**存为「事务所样式预设」**，下次一键复用，解决「事务所规定」。
- 支持**对话驱动**：用户说「正文字号调到 12pt、页边距上下 2cm」，agent 更新参数、面板实时联动（这正是 BitFun「对话绑定界面状态」的精神）。

### 2.2 架构（复用 BitFun 的「文件协议 + 事件过滤 + iframe 桥」，降维落地）

```
[文书内容生成] draft_specification / draft_claims / patent-oa-response
      │ 产出 sections (element id → innerHTML)  ← 已有能力
      ▼
render_patent_document(template, sections, style: DocumentStyle)
      │ style 编译为 CSS 变量覆盖 → 复用 buildBrandStyle 机制扩展
      ▼
落盘 .html ──► 前端 Style Panel (iframe sandbox + srcdoc + postMessage)
      │  左栏: 排版参数表单 (字号/行距/页边距/字体/颜色/页眉落款)
      │  右栏: 实时预览 (srcdoc 重渲染)
      │  参数变化 → postMessage → 宿主重渲染预览 → 回传
      ▼
「锁定导出」→ render_patent_document(style=最终参数) → HTML/PDF
「保存为预设」→ 写 theme.json documents.patent 或独立 style-preset.json
```

### 2.3 分步实施

**Step 1 —— 排版尺度 token 化（补齐根因①，纯 CSS 层，零风险）**

- 统一各模板：把硬编码字号/行距/间距改为引用 `tokens.css` 已有的 `--sati-doc-text-*`/`--sati-doc-leading-*`/`--sati-doc-section-gap*`，并补齐缺失 token（标题各级字号 `h1~h4`、表格字号、段间距 `paragraph-gap`、首行缩进 `indent`）。
- 扩展 `brandInjector.ts` 的 `BRAND_KEY_TO_CSS_VAR`，新增排版尺度 key：`textXs/textSm/textBase/textMd/textLg/textXl/text2xl/leadingBody/leadingTight/pageMargin/bodyMaxWidth/sectionGap/sectionGapLg/paragraphGap/indent`。
- 同步更新 `tokens.css` 的默认值与 `manifest.json` 的 `page.margins`。

**Step 2 —— 排版参数 schema（结构化参数模型）**

- 新增 `DocumentStyle` 类型 + JSON Schema（放 `src/patent/document/style.ts`），分组：
  - **字号**：正文 / 小字 / 标题 H1–H4 / 表格
  - **行距**：正文 / 紧凑
  - **页边距**：上下左右（mm）
  - **字体**：衬线 / 无衬线 / 等宽
  - **颜色**：主色 / 正文 / 表头背景 / 边框
  - **页眉页脚**：事务所名 / 密级标记 / 落款 / 页码格式
  - **段落**：段间距 / 首行缩进（中文字数）
- 这份 schema 同时作为：面板表单模型 + `render_patent_document` 的 `style` 入参 + 样式预设的持久化载体。

**Step 3 —— 渲染参数化 + 样式预设持久化**

- `renderPatentDocument` 增加 `style?: DocumentStyle` 入参，`types.ts` 的 `DocumentRenderInput` 补 `style` 字段。
- 新增 `buildStyleOverrides(style)`（复用 `buildBrandStyle` 的编译逻辑）：把 `DocumentStyle` 编译为 `--sati-doc-*` 覆盖。
- 新增样式预设读写：`saveStylePreset` / `listStylePresets` / `loadStylePreset`，预设写入 `theme.json` 的 `documents.patent` 或独立 `products/<product>/brand/style-presets/*.json`（复用现有 brand 目录约定）。

**Step 4 —— 前端调参面板（Mini App 形态）**

- 改造 `ui/src/components/code-editor/view/subcomponents/HtmlDocumentPreview.tsx` 为 `StylePanel.tsx`：`srcdoc` + `postMessage` 桥 + 订阅 `DocumentStyle` 状态。
- 新增 `ui/src/components/patent/StylePanel/`：左栏参数表单（滑块/下拉/颜色选择器/文本框）、右栏实时预览。
- 新增事件通道：复用 §2.2 已调研的 `WebMessage.payload` + `useSessionStore` 增量机制，或新增 `style_update` 事件（协议改动点见下）。
- 前端渲染已生成的 `.html`，参数变化时用 `srcdoc` 重渲染（重渲染比改 CSS 变量更简单可靠，文书体积小）。

**Step 5 —— 高频模板优先 + 对话驱动**

- 先覆盖 `claims-spec`、`oa-response` 两个模板的 token 化 + 面板；其余三模板（patentability-opinion / search-report / invalidation-opinion）后续跟进。
- 新增/复用工具让 agent 能「读当前排版参数、更新参数、保存预设」，使「对话里说一句调排版」成为可能。

### 2.4 落点清单（文件级）

| 层 | 文件 | 动作 |
|---|---|---|
| 排版 token | `assets/templates/patent/tokens.css` | 补齐标题/段间距/缩进 token |
| 模板 | `assets/templates/patent/{claims-spec,oa-response}/assets/template.html` | 硬编码字号/行距改为引用 token |
| 品牌映射 | `src/patent/document/brandInjector.ts` | `BRAND_KEY_TO_CSS_VAR` 扩展排版尺度 key |
| 类型 | `src/patent/document/types.ts` | 新增 `DocumentStyle`、`style` 入参 |
| 样式编译 | `src/patent/document/style.ts`（新） | `buildStyleOverrides` + preset 读写 |
| 渲染 | `src/patent/document/renderPatentDocument.ts` | 接 `style` 入参 |
| 工具 | `src/tool/builtin/renderPatentDocument.ts` | 透出 `style` 参数 + preset 工具 |
| 事件 | `src/gateway/protocol/types.ts` + `src/web/client/protocol.ts` | 可选 `style_update` 事件 |
| 前端面板 | `ui/src/components/patent/StylePanel/`（新） | 表单 + 实时预览 + postMessage 桥 |

---

## 3. 方案二：KV Cache 无损字节稳定 + 度量补全【P1，降风险】

### 3.1 质量红线（硬约束）

- **不移动任何语义内容**：memory 附件、项目指令、methodology addendum 的**位置与内容保持原样**，不做「移到动态后缀」这类改变信息顺序的改造。
- **只做「无损」动作**：字节稳定化只针对「非语义」字节（时间戳格式、随机 ID 确定性、排序一致性），以及「缓存身份/度量」这类不改内容的机制。
- **质量回归门槛**：所有改动须通过「重建 invariant 对拍」+ 专利答案质量回归，确保送达模型的字节序列在语义上等价。

### 3.2 保留的 BitFun 可迁移纪律（只选无损项）

| BitFun 纪律 | Sati 落点 | 是否改内容 |
|---|---|---|
| 命中/写入分开计量 | `normalizeUsage.ts` 补读 DeepSeek `prompt_cache_hit_tokens` | 否 |
| 缓存身份键只含稳定特征 | system prompt 按「模板 hash」缓存（只缓存，不改字节） | 否 |
| 工具列表稳定排序 | 确认 `ToolRegistry.list` 按名排序（已实现），补「集合跨轮稳定」保证 | 否 |
| 时间戳/随机值隔离 | `now` 日期格式统一、随机 ID 生成确定性化（非语义） | 否（仅格式） |
| 压缩显式失效-重建 | `CompactionEngine` 的 compact-boundary 写前缀指纹（用于诊断，不改历史） | 否 |

### 3.3 分步实施

**Phase A —— 度量补全（零风险，立竿见影）**

- `src/model/response/normalizeUsage.ts` 补读 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，使 DeepSeek 缓存命中计入 `cacheReadTokens`。
- `src/model/request/buildModelRequest.ts` 让 `supportsPromptCache` 进入降级层（当前零消费）。
- 校验 DeepSeek 真实响应字段名（避免空采集）。

**Phase B —— 无损字节稳定（非语义）**

- 统一 `now` 日期串格式（`toISOString().slice(0,10)` → 会话级固定常量或固定格式）。
- 随机 ID（文件名 tmp、重试 id）生成确定性化。
- 确认工具列表排序在 plan_mode/`promptBlockedToolNames` 过滤下仍稳定。

**Phase C —— 缓存身份 + 指纹诊断（可选，不改内容）**

- system prompt 按「稳定前缀 hash」建立 session 级缓存身份（仅用于跨轮复用判断，不改字节）。
- compact-boundary 写入前缀指纹，供「命中率诊断」而非改写。

### 3.4 落点清单（文件级）

| 文件 | 动作 |
|---|---|
| `src/model/response/normalizeUsage.ts` | 补读 DeepSeek 缓存命中 token |
| `src/model/request/buildModelRequest.ts` | `supportsPromptCache` 进入降级层 |
| `src/context/prompt/PromptAssembler.ts` | `now` 格式统一（非语义） |
| `src/context/compaction/CompactionEngine.ts` | compact-boundary 前缀指纹（诊断） |
| `src/tool/registry/ToolRegistry.ts` | 集合跨轮稳定保证 |

---

## 4. 质量保障（对齐反馈②）

1. **方案一不碰模型**：排版面板是纯渲染后处理；用「渲染前后正文内容 diff」作为门禁，确保只有 CSS/token 变化、正文零变更。
2. **方案二不动语义**：所有动作限定在「非语义字节」与「度量/缓存身份」，语义内容字节序列保持不变；用 request 重建对拍器断言。
3. **回归测试**：每阶段附「文书排版快照测试」与「专利答案质量回归」；复用 Sati 现有 `tests/` 与 `patent_workflow` 评测。

---

## 5. 里程碑与验收

| 里程碑 | 内容 | 估算 | 风险 |
|---|---|---|---|
| M1 | Step 1（token 化）+ Step 2（schema）+ Phase A（度量补全） | 3–5 天 | 低，纯增量 |
| M2 | Step 3（渲染参数化+预设）+ Step 4（调参面板） | 1–2 周 | 中，前端 srcdoc 桥 |
| M3 | Step 5（对话驱动+高频模板收口）+ Phase B/C | 2–3 周 | 中 |
| M4（可选） | 其余三模板 + 通用 Mini App 框架 | 暂缓 | 高，过度设计风险 |

**验收（可度量）**

- [ ] `claims-spec`/`oa-response` 字号/行距/页边距可经面板实时调整，预览 ≤1s 刷新
- [ ] 调参结果可保存为「事务所样式预设」并一键复用
- [ ] 对话里说「正文字号 12pt、页边距上下 2cm」能驱动面板联动
- [ ] 排版调整前后正文内容 diff 为空（仅 CSS/token 变化）
- [ ] DeepSeek 会话 usage 采集到缓存命中 token；`supportsPromptCache` 被消费
- [ ] 语义内容字节序列经对拍断言不变（方案二无损）

---

## 6. 结论

三点反馈把方向收敛得很清晰：

- **Mini App 的正确落点是「文书排版实时调参面板」，不是通用 UI 框架，也不是结构化工件展示**——它直击「排版定死 + 事务所规定」的真实痛点，且纯渲染后处理、零模型质量风险。
- **KV Cache 只做「无损」部分**：度量补全（DeepSeek 采集）+ 非语义字节稳定 + 缓存身份/指纹诊断，明确不移动任何语义内容，守住「质量不降低」的红线。
- 建议按 **M1 → M2 → M3** 推进，M1 三到五天即可让「排版可配」落地，M2 交付可交互的调参面板。

# BitFun 优秀设计引入方案（修订版 v3.1）—— 文书排版实时调参面板 + KV Cache 无损稳定

- 创建日期：2026-08-20（v1）；2026-08-20（v2 修订，对齐三点反馈）；2026-08-20（v3 修订，对齐代码评审）；2026-08-20（v3.1 实施进度同步）
- 状态：**实施中**（v3.1：Step 2/3 后端已落地；并行窗口落地预设持久化；本窗口完成 Step 1 两模板 token 化与 Phase A normalizeUsage）
- 上游：BitFun（`GCWing/BitFun`）「Agentic Mini App」与「KV Cache 前缀字节稳定」两项能力深挖

---

## 0. 修订说明

### v2（对齐用户三点反馈）

| # | 用户反馈 | 本版调整 |
|---|---|---|
| 1 | 高频场景是**权利要求书/说明书撰写、意见答复** | Mini App 场景从「Claim Chart 展示面板」**重定位为「HTML 文书排版实时调参面板」**，优先落地 `claims-spec`（权利要求书+说明书）、`oa-response`（意见答复）两个模板 |
| 2 | **专利执行质量必须不降低** | 方案一（排版面板）纯渲染后处理，不碰模型、不碰生成内容；方案二（KV Cache）**降级为「无损字节稳定 + 度量补全」**，明确「不移动任何语义内容」 |
| 3 | 痛点 = HTML 排版凭个人喜好/事务所规定、**模板定死** | 直击该痛点：把排版尺度参数化 + 提供「生成时实时调整 + 实时预览 + 样式预设持久化」 |

### v3（对齐代码评审，2026-08-20）

| # | 评审发现 | 本版调整 |
|---|---|---|
| 1 | 文档标注「未实施」但代码已部分落地 | 逐文件核对代码现状，各步骤标注 ✅ 已落地 / ⚠️ 部分 / ❌ 未落地 |
| 2 | **Step 1（模板 token 化）未落地**，导致已实现的后端参数化（Step 2/3）注入的 CSS 覆盖不生效 | 将 Step 1 明确为 **P0 前置依赖**（先于 Step 4），并补「token 生效断言」验收项 |
| 3 | 文档 key/分组清单与实际实现不符（`paragraphGap`/`indent` 未实现，实为 `bodyPadding`；无「页眉页脚」「段落」独立组） | Step 2 描述对齐实际实现：七组结构、key 清单以 `brandInjector.ts` 的 `BRAND_KEY_TO_CSS_VAR` 为准 |
| 4 | 样式预设持久化未落地，且写入 `products/<product>/brand/` 会污染仓库配置、违反 WorkSpace 隔离 | 预设改为**用户级目录**（`~/.sati/style-presets/`），补写入路径与文件名校验要求 |
| 5 | `render_patent_document` 工具 inputSchema 已加 `style` 字段 → **toolSchemaDigest 变化 → llm-replay fixture 失配**（CLAUDE.md 明示的坑） | 新增 §4.4 约束 + §5 验收项；先验证后重录 fixture |
| 6 | `manifest.json` 页边距（16/18mm）与 `tokens.css`（20/25mm）不一致，屏幕预览与 PDF 打印基准不统一 | Step 1 补充「统一页边距基准」动作，明确以 `tokens.css` 为唯一来源 |
| 7 | `style_update` 事件标注「可选」但对话驱动验收依赖它 | 改为「M3 必做（或明确降级为「更新后提示刷新」并写入验收）」，与验收对齐 |
| 8 | 缺 i18n、事件矩阵门禁、五模板基准一致性、命中率基线指标 | 分别在 §2.4/§3.3/§5 补齐 |

### v3.1（实施进度同步，2026-08-20）

| 项 | 状态 |
|---|---|
| Step 1 模板 token 化（`claims-spec`/`oa-response` + `tokens.css` 补 `paragraph-gap`/`indent`） | ✅ 已落地（本窗口，含 token 生效断言测试） |
| Step 1 其余三模板 | ❌ 待做（`invalidation-opinion`/`search-report` 模板正被并行窗口修改，暂缓避免冲突） |
| Step 3 预设持久化 | ⚠️ 并行窗口已实现（`products/<产品>/brand/style-presets/` + `document_style_preset` 工具），与本文档 v3 建议的用户级路径（`~/.sati/`）**存在分歧，实施前须对齐决策** |
| Phase A `normalizeUsage` 补读 DeepSeek 缓存字段 | ✅ 已落地（`prompt_cache_hit_tokens` → `cacheReadTokens`；miss 计入 `inputTokens`） |
| Phase A `buildModelRequest` 降级层 | ❌ 待真实 DeepSeek 响应校验字段名后实施 |
| llm-replay fixture | ⚠️ 已实测失配（`llm-replay-real.spec.ts` 红），待重录（需 API key） |

---

## 1. 痛点根因（v3 已逐文件核实）

Sati 的专利文书渲染链路现状（`src/patent/document/`）：

```
theme.json (documents.patent) ──► brandInjector.ts (BRAND_KEY_TO_CSS_VAR 映射)
   ──► buildBrandStyle() 编译 CSS 变量 ──► 注入模板 <head> 覆盖 --sati-doc-*
   ──► 模板 :root { --doc-*: var(--sati-doc-*, fallback) } ──► 排版生效
```

**「排版定死」有三层根因（v3 新增第 3 条）：**

1. **排版尺度未 token 化**：`tokens.css` 已定义 `--sati-doc-text-*`/`--sati-doc-leading-*`/`--sati-doc-section-gap*`/`--sati-doc-page-margin` 等 token，但**模板没有引用字号/行距/间距 token**：`claims-spec`/`oa-response` 模板的 `:root` 只透传了 `--doc-page-margin`/`--doc-body-padding`/`--doc-body-max-width`/`--doc-font-*`，正文仍是硬编码——`html { font-size: 12pt }`、`body { line-height: 1.5 }`、表格/元数据 `10.5pt`、页脚/表注 `9pt`、主标题 `16pt`、H2 `14pt`（历史遗留不一致）。

2. **无交互 + 无持久化**：`brandInjector.ts` 的 `BRAND_KEY_TO_CSS_VAR` 映射表已扩展排版尺度 key（v3 核对：`textXs~text2xl`/`leadingBody`/`leadingTight`/`pageMargin`/`bodyPadding`/`bodyMaxWidth`/`sectionGap`/`sectionGapLg`，见 §2.3 Step 2），但 `theme.json` 仍是静态配置文件（注释「待 PilotConfig.brand 贡献点就绪后读取」），改一次要重跑，不能「生成时实时调整」。事务所的「样式规定」也无法沉淀为可复用预设。

3. **页边距双基准（v3 新增）**：`assets/templates/patent/manifest.json` 的 `page.margins` 为 **16/18mm**，与 `tokens.css` 的 **20/25mm** 不一致——屏幕预览与 PDF 打印基准不同，WYSIWYG 不可靠。

**结论**：这是 Mini App 的完美适用场景——一个「排版参数表单 + 实时预览」的调参面板，且**纯渲染后处理、零模型质量风险**。但必须先完成 Step 1（模板 token 化），否则后端参数化注入的 CSS 覆盖对渲染结果无效。

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
      │ style 编译为 CSS 变量覆盖 → 复用 buildBrandStyle 机制扩展（✅ 已落地）
      ▼
落盘 .html ──► 前端 Style Panel (iframe sandbox + srcdoc + postMessage)
      │  左栏: 排版参数表单 (字号/行距/页边距/字体/颜色/页眉落款)
      │  右栏: 实时预览 (srcdoc 重渲染)
      │  参数变化 → postMessage → 宿主重渲染预览 → 回传
      ▼
「锁定导出」→ render_patent_document(style=最终参数) → HTML/PDF
「保存为预设」→ 写 ~/.sati/style-presets/<name>.json（用户级，WorkSpace 隔离）
```

### 2.3 分步实施（各步标注当前状态）

**Step 1 —— 排版尺度 token 化（补齐根因①，纯 CSS 层，零风险）【P0 前置依赖，✅ claims-spec/oa-response 已落地（2026-08-20）；其余三模板待做】**

> ⚠️ **为什么是 P0 前置依赖**：`render_patent_document` 已支持 `style` 入参（Step 2/3 已落地），但模板正文不引用 `--sati-doc-text-*`/`--sati-doc-leading-*` token 时，注入的 CSS 覆盖**对渲染结果无效**。此步不完成，调参面板整条链路不可用。

- 统一各模板：把硬编码字号/行距/间距（`font-size: 12pt`、`line-height: 1.5` 等）改为引用 `tokens.css` 的 `--sati-doc-*` token，并补齐缺失 token（标题各级字号 `h1~h4`、表格字号、段间距 `paragraph-gap`、首行缩进 `indent`）。模板 `:root` 需透传新 token（对齐现有 `--doc-page-margin` 的透传写法）。**进度（v3.1）**：`claims-spec`/`oa-response` 已完成（`:root` 透传 `--doc-text-*`/`--doc-leading-*`/`--doc-section-gap`/`--doc-paragraph-gap` 等，正文/标题/表格/页脚全部改引用 token）；`tokens.css` 已补 `--sati-doc-paragraph-gap`（1.5mm）/`--sati-doc-indent`（0，模板暂不引用）；其余三模板待做（其中 invalidation-opinion/search-report 正被并行窗口修改，暂缓）。
- **统一页边距基准（v3 新增）**：`manifest.json` 的 `page.margins` 以 `tokens.css` 的 `--sati-doc-page-margin`（20/25mm）为唯一来源同步，消除屏幕预览与 PDF 打印不一致；`@page` 规则引用同一 token。
- **五模板基准一致性（v3 新增）**：即使面板先只做 `claims-spec`/`oa-response`，其余三模板（patentability-opinion / search-report / invalidation-opinion）也应在 M1 同步完成 token 引用（纯 CSS 改动成本低），避免五模板字号/行距基准不一致。
- 扩展 `brandInjector.ts` 的 `BRAND_KEY_TO_CSS_VAR` 补 `paragraphGap`/`indent`（如需要）——v3 核对：现已有 `textXs~text2xl`/`leadingBody`/`leadingTight`/`pageMargin`/`bodyPadding`/`bodyMaxWidth`/`sectionGap`/`sectionGapLg`。

**Step 2 —— 排版参数 schema（结构化参数模型）【✅ 已落地，v3 对齐实际实现】**

- 已落地：`DocumentStyle` 类型在 `src/patent/document/types.ts`，JSON Schema 在 `src/patent/document/style.ts`（`DOCUMENT_STYLE_JSON_SCHEMA`，供工具 inputSchema 与前端调参面板复用）。
- **实际分组（以代码为准）**：
  - **字号** `fontSize`：`xs`（小五 9pt）/ `sm`（五号 10.5pt）/ `base`（小四 12pt）/ `md`（H4）/ `lg`（H3）/ `xl`（H2）/ `x2l`（H1）
  - **行距** `leading`：`body`（正文）/ `tight`（紧凑）
  - **页面** `page`：`margin`（页边距 mm）/ `padding`（正文内边距）/ `bodyMaxWidth`（正文最大宽度）
  - **间距** `spacing`：`sectionGap` / `sectionGapLg`
  - **字体** `font`：`serif` / `sans` / `mono`
  - **颜色** `color`：`accent` / `accentStrong` / `body` / `muted` / `border` / `headerBg` / `surface` / `zebra` / `danger` / `warning` / `success`
  - **机构与文案** `brand`：`firm` / `confidential` / `disclaimer`（页眉页脚归属此组，无独立「页眉页脚」组）
- v3 说明：文档 v2 中「页眉页脚组」「段落组（段间距/首行缩进）」未落地为独立组；如需段间距/首行缩进调参，在 `spacing` 补 `paragraphGap`/`indent` 字段并同步 `BRAND_KEY_TO_CSS_VAR`。

**Step 3 —— 渲染参数化 + 样式预设持久化【⚠️ 部分落地】**

- ✅ 已落地：`renderPatentDocument` 的 `DocumentRenderInput` 已补 `style?` 字段；`buildStyleOverrides(style)`（`style.ts`）复用 `buildBrandStyle` 编译逻辑，与 `brand` 合并后注入 `<head>`（优先级：`style` > `brand` > theme.json）。
- ✅ 已落地：`render_patent_document` 工具透出 `style` 参数（`inputSchema` 引用 `DOCUMENT_STYLE_JSON_SCHEMA`，`style` 优先级高于 `brand`/`brand_path`）。
- ❌ 未落地（v3 评估时）：样式预设读写 `saveStylePreset` / `listStylePresets` / `loadStylePreset`。**⚠️ v3.1 更新：并行窗口已实现**——`src/patent/document/stylePreset.ts`（save/list/load/delete + `resolvePresetDirFromBrandPath`）+ `document_style_preset` 工具（已注册），写入路径为 **`products/<产品>/brand/style-presets/<name>.json`**。**路径决策分歧待对齐**：本版文档 v3 建议用户级 `~/.sati/style-presets/`（避免污染仓库白标配置、多工作区互踩）；并行实现采用品牌目录（预设跟随白标产品配置，本地示例便捷）。两者取一后回写本节与 §5 验收。实现要点（无论路径）：
  - 预设文件为 `DocumentStyle` JSON，顶层含 `name`/`description`/`updatedAt` 元数据。
  - 文件名 sanitize 复用 `renderPatentDocument.ts` 的 `SAFE_NAME_PATTERN`（仅字母数字 `._-`），防路径穿越。

**Step 4 —— 前端调参面板（Mini App 形态）【❌ 未落地】**

- 改造 `ui/src/components/code-editor/view/subcomponents/HtmlDocumentPreview.tsx` 为 `StylePanel.tsx`：`srcdoc` + `postMessage` 桥 + 订阅 `DocumentStyle` 状态。
- 新增 `ui/src/components/patent/StylePanel/`：左栏参数表单（滑块/下拉/颜色选择器/文本框）、右栏实时预览。
- **i18n（v3 新增，CLAUDE.md 强制项）**：面板全部文案提取到 `ui/src/i18n/locales/{en,zh-CN}/` 对应 namespace（建议 `patent.json`）。
- **事件通道（v3 改为必做，见 §2.4）**：新增 `style_update` 事件（协议改动，见 §5 事件矩阵门禁），或复用 `WebMessage.payload` + `useSessionStore` 增量机制；二选一须在 M3 前定稿并写入本节的最终决策。
- 前端渲染已生成的 `.html`，参数变化时用 `srcdoc` 重渲染（重渲染比改 CSS 变量更简单可靠，文书体积小）。

**Step 5 —— 高频模板优先 + 对话驱动【❌ 未落地】**

- 先覆盖 `claims-spec`、`oa-response` 两个模板的 token 化 + 面板；其余三模板（patentability-opinion / search-report / invalidation-opinion）M1 完成 token 引用、M4 完成面板。
- 新增工具让 agent 能「读当前排版参数（`list_style_presets`/`load_style_preset`）、更新参数（`style` 入参）、保存预设（`save_style_preset`）」，使「对话里说一句调排版」成为可能；面板联动依赖 §2.4 的事件通道。

### 2.4 落点清单（文件级，含状态与 v3 补充）

| 层 | 文件 | 动作 | 状态 |
|---|---|---|---|
| 排版 token | `assets/templates/patent/tokens.css` | 补齐标题/段间距/缩进 token（`paragraph-gap`/`indent` 已补）；页边距唯一基准待统一 | ✅ 已落地（基准统一待做） |
| 模板 | `assets/templates/patent/{claims-spec,oa-response}/assets/template.html` | 硬编码字号/行距改为引用 token；`:root` 透传新 token | ✅ 已落地（v3.1） |
| 模板（其余三模板） | `assets/templates/patent/{patentability-opinion,search-report,invalidation-opinion}/assets/template.html` | 同上（invalidation-opinion/search-report 正被并行窗口修改，暂缓） | ❌ 待做 |
| 品牌映射 | `src/patent/document/brandInjector.ts` | `BRAND_KEY_TO_CSS_VAR` 排版尺度 key（已加）；按需补 `paragraphGap`/`indent` | ✅ 已落地（缺项待定） |
| 类型 | `src/patent/document/types.ts` | `DocumentStyle`（七组）、`DocumentRenderInput.style`、`StylePreset` | ✅ 已落地 |
| 样式编译 | `src/patent/document/style.ts` | `flattenDocumentStyle`/`buildStyleOverrides`/`DOCUMENT_STYLE_JSON_SCHEMA` | ✅ 已落地 |
| 预设持久化 | `src/patent/document/stylePreset.ts`（并行窗口） | `saveStylePreset`/`listStylePresets`/`loadStylePreset`/`deleteStylePreset` → `products/.../style-presets/` | ⚠️ 已落地，路径决策待对齐 |
| 渲染 | `src/patent/document/renderPatentDocument.ts` | `style` 入参合并注入（优先级 style > brand > theme.json） | ✅ 已落地 |
| 工具 | `src/tool/builtin/renderPatentDocument.ts` + `documentStylePreset.ts` | 透出 `style`；预设工具已注册 | ✅ 已落地（`style_preset` 参数待接） |
| 事件 | `src/gateway/protocol/types.ts` + `src/web/client/protocol.ts` | `style_update` 事件（v3：M3 必做；过 `pnpm check:event-matrix` 门禁） | ❌ 未落地 |
| 前端面板 | `ui/src/components/patent/StylePanel/`（新） | 表单 + 实时预览 + postMessage 桥；文案入 i18n | ❌ 未落地 |

---

## 3. 方案二：KV Cache 无损字节稳定 + 度量补全【P1，降风险】

### 3.1 质量红线（硬约束）

- **不移动任何语义内容**：memory 附件、项目指令、methodology addendum 的**位置与内容保持原样**，不做「移到动态后缀」这类改变信息顺序的改造。
- **只做「无损」动作**：字节稳定化只针对「非语义」字节（时间戳格式、随机 ID 确定性、排序一致性），以及「缓存身份/度量」这类不改内容的机制。
- **质量回归门槛**：所有改动须通过「重建 invariant 对拍」+ 专利答案质量回归，确保送达模型的字节序列在语义上等价。

### 3.2 保留的 BitFun 可迁移纪律（只选无损项）

| BitFun 纪律 | Sati 落点 | 是否改内容 | 状态 |
|---|---|---|---|
| 命中/写入分开计量 | `normalizeUsage.ts` 补读 DeepSeek `prompt_cache_hit_tokens` | 否 | ❌ 未落地（当前只读 Anthropic 风格字段 `cache_read_input_tokens`/`cached_tokens`） |
| 缓存身份键只含稳定特征 | system prompt 按「模板 hash」缓存（只缓存，不改字节） | 否 | ❌ 未落地 |
| 工具列表稳定排序 | `ToolRegistry.list` 按名排序（✅ 已实现：`localeCompare` + `sortedCache`），补「集合跨轮稳定保证」 | 否 | ⚠️ 排序已实现，过滤稳定性保证待补 |
| 时间戳/随机值隔离 | `now` 日期格式统一、随机 ID 生成确定性化（非语义） | 否（仅格式） | ❌ 未落地（`PromptAssembler` 仍 `toISOString().slice(0,10)`） |
| 压缩显式失效-重建 | `CompactionEngine` 的 compact-boundary 写前缀指纹（用于诊断，不改历史） | 否 | ⚠️ `<compact-boundary>` 标记已有（trigger/preTokens/…），前缀指纹未加 |

### 3.3 分步实施（各步标注当前状态）

**Phase A —— 度量补全（零风险，立竿见影）【⚠️ 部分落地：normalizeUsage ✅，buildModelRequest ❌】**

- ✅ 已落地（v3.1）：`src/model/response/normalizeUsage.ts` 补读 DeepSeek 字段——`prompt_cache_hit_tokens` 计入 `cacheReadTokens`（优先级：`details.cached_tokens` > `prompt_cache_hit_tokens` > `cache_read_input_tokens`）；`prompt_cache_miss_tokens` 不映射为 `cacheWriteTokens`（DeepSeek 无 cache write 计量，miss 属本次输入，经 `inputTokens` 计算自然落位）。含确定性单测（`tests/model/normalizeUsage.spec.ts`）。
- ❌ 待做：`src/model/request/buildModelRequest.ts` 让 `supportsPromptCache` 进入降级层（v3 核对：`supportsPromptCache` 字段存在于 `src/model/protocol/capabilities.ts`，全项目无 `true` 配置，request 层零消费）。
- **必须先校验真实 DeepSeek 响应字段名**（避免空采集）：以一次带缓存命中的真实请求确认 `usage.prompt_cache_hit_tokens` 的层级与命名（v3.1 实现按文档字段名解析、读不到安全回退 undefined，待真实响应确认后收口）。

**Phase B —— 无损字节稳定（非语义）【❌ 未落地】**

- 统一 `now` 日期串格式（`PromptAssembler.ts:159-160` 当前为 `new Date()` + `toISOString().slice(0,10)` → 会话级固定常量或固定格式）。
- 随机 ID（文件名 tmp、重试 id）生成确定性化。
- 确认工具列表排序在 plan_mode/`promptBlockedToolNames` 过滤下仍稳定（补「集合跨轮稳定」单测：同一注册表两次 `list()` 字节一致；过滤前后顺序一致）。

**Phase C —— 缓存身份 + 指纹诊断（可选，不改内容）【⚠️ 部分落地】**

- system prompt 按「稳定前缀 hash」建立 session 级缓存身份（仅用于跨轮复用判断，不改字节）。
- compact-boundary 写入前缀指纹（`CompactionEngine.ts` 已有 `<compact-boundary>` 标记，补前缀 hash 字段供「命中率诊断」而非改写）。
- **收益预期（v3 新增）**：本方案不动语义内容排序，KV Cache 命中率提升有限；定位为「诊断 + 度量 + 消除非语义抖动」而非「命中率优化」。M3 验收补**可选基线指标**：同任务重放两轮，对比首/次轮 `prompt_cache_hit_tokens` 占比，仅记录不设硬门槛。

### 3.4 落点清单（文件级，含状态）

| 文件 | 动作 | 状态 |
|---|---|---|
| `src/model/response/normalizeUsage.ts` | 补读 DeepSeek 缓存命中 token | ✅ 已落地（v3.1） |
| `src/model/request/buildModelRequest.ts` | `supportsPromptCache` 进入降级层 | ❌ |
| `src/context/prompt/PromptAssembler.ts` | `now` 格式统一（非语义） | ❌ |
| `src/context/compaction/CompactionEngine.ts` | compact-boundary 前缀指纹（诊断） | ⚠️ 标记已有，指纹未加 |
| `src/tool/registry/ToolRegistry.ts` | 集合跨轮稳定保证（排序已实现） | ⚠️ 补单测 |

---

## 4. 质量保障（对齐反馈②）

1. **方案一不碰模型**：排版面板是纯渲染后处理；**「渲染前后正文内容 diff」固化为 `renderPatentDocument` 单测**——注入 `style` 前后提取正文文本（剥离标签）断言逐字一致，确保只有 CSS/token 变化、正文零变更。
2. **方案二不动语义**：所有动作限定在「非语义字节」与「度量/缓存身份」，语义内容字节序列保持不变；用 request 重建对拍器断言。
3. **回归测试**：每阶段附「文书排版快照测试」与「专利答案质量回归」；复用 Sati 现有 `tests/` 与 `patent_workflow` 评测。
4. **llm-replay fixture 约束（v3 新增，CLAUDE.md 明示）**：`render_patent_document` 工具 inputSchema 已加 `style`（含 `DOCUMENT_STYLE_JSON_SCHEMA`）→ **toolSchemaDigest 变化 → `tests/fixtures/llm-replay/deepseek-v4-flash-basic` 既有 fixture 已失配（v3 实测：`llm-replay-real.spec.ts` 红，记录未被消费）**（请求键含 `{name, inputSchema}` 投影）。后续任何 inputSchema 改动（含描述文本）都须：先跑 `llm-replay-real.spec.ts` 确认失配 → 重录 fixture（`SATI_LLM_REPLAY_RECORD_ROOT` + `scripts/record-real-fixture.ts`，需 API key）→ `pnpm record:replay` 校验。**说明性文字放工具顶层 description，不放 inputSchema**。

---

## 5. 里程碑与验收

| 里程碑 | 内容 | 估算 | 风险 | 状态 |
|---|---|---|---|---|
| M1 | Step 1（token 化，**五模板统一 token 引用**，面板先做两模板）+ Phase A（度量补全） | 3–5 天 | 低，纯增量 | ⚠️ 进行中（两模板 + normalizeUsage 已落地；其余三模板与 buildModelRequest 待） |
| M2 | Step 3 预设持久化（`~/.sati/style-presets/`）+ Step 4（调参面板，含 i18n） | 1–2 周 | 中，前端 srcdoc 桥 | ❌ 未开始 |
| M3 | Step 5（对话驱动 + `style_update` 事件 + 预设三工具）+ Phase B/C | 2–3 周 | 中 | ❌ 未开始 |
| M4（可选） | 其余三模板面板 + 通用 Mini App 框架 | 暂缓 | 高，过度设计风险 | 暂缓 |

**验收（可度量）**

- [ ] `claims-spec`/`oa-response` 字号/行距/页边距可经面板实时调整，预览 ≤1s 刷新
- [ ] **token 生效断言（v3 新增）**：修改 `--sati-doc-text-base`（或 `style.fontSize.base`）后渲染 HTML 的字号变化——此条是 Step 1 完成的前置验收
- [ ] 调参结果可保存为「事务所样式预设」（`~/.sati/style-presets/`）并一键复用；非法文件名被拒
- [ ] 对话里说「正文字号 12pt、页边距上下 2cm」能驱动面板联动（依赖 `style_update` 事件通道）
- [ ] 排版调整前后正文内容 diff 为空（仅 CSS/token 变化，单测固化）
- [ ] DeepSeek 会话 usage 采集到 `prompt_cache_hit_tokens`；`supportsPromptCache` 被消费
- [ ] 语义内容字节序列经对拍断言不变（方案二无损）
- [ ] **fixture 匹配（v3 新增）**：`pnpm record:replay tests/fixtures/llm-replay/deepseek-v4-flash-basic` 通过，`llm-replay-real.spec.ts` 绿
- [ ] **事件矩阵（v3 新增）**：`pnpm check:event-matrix` 通过（如新增 `style_update` 事件）
- [ ] （可选）同任务两轮重放 `prompt_cache_hit_tokens` 占比基线记录

---

## 6. 结论

三点反馈把方向收敛得很清晰；v3 评审又把「文档与代码脱节」补齐：

- **Mini App 的正确落点是「文书排版实时调参面板」，不是通用 UI 框架，也不是结构化工件展示**——它直击「排版定死 + 事务所规定」的真实痛点，且纯渲染后处理、零模型质量风险。
- **当前进度（v3.1 核对）**：后端参数化已落地（`DocumentStyle` schema + `style` 入参 + 工具透出）；**Step 1 模板 token 化已完成 `claims-spec`/`oa-response`（P0 前置依赖已解除，含 token 生效断言测试）**，其余三模板待做；预设持久化由并行窗口落地（路径决策待对齐）；Phase A `normalizeUsage` 已落地；前端面板、对话驱动、Phase B/C 未落地。
- **KV Cache 只做「无损」部分**：度量补全（DeepSeek 采集，`normalizeUsage` 已落地）+ 非语义字节稳定 + 缓存身份/指纹诊断，明确不移动任何语义内容，守住「质量不降低」的红线；定位为诊断与度量，不承诺命中率提升。
- 建议按 **Step 1（收口其余三模板）→ M2 → M3** 推进：Step 1 让「排版可配」真正生效，M2 交付可交互的调参面板；**并行处理 llm-replay fixture 重录**（v3 已实测：`llm-replay-real.spec.ts` 红，`assertAllConsumed` 报「the test never drove 1 recorded stream(s): 0」——请求键与 fixture 记录键不匹配，须用 `scripts/record-real-fixture.ts` 重录后提交）。

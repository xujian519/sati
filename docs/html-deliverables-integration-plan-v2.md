# Sati HTML 交付物升级实施方案（V2）

> 目标：吸收 `nexu-io/html-anything` 的可复用工程方法，使 Sati 生成的非正式文书类 HTML
> 交付物更美观、更稳定、更符合交付标准，同时不破坏现有专利文书体系。
>
> V2 修订要点：
> 1. 许可证表述改为“只借鉴方法/结构；如需复制代码或素材，保留 Apache-2.0 声明并请法务确认”。
> 2. 不再默认修改 `PromptAssembler` 做全局注入，避免影响 llm-replay fixture；改为模板 SKILL.md 强制引用共享契约。
> 3. 新增打包/分发验证任务。
> 4. 首批模板从 6 个收敛为 4 个，`meeting-notes` / `finance-report` 移入 P2 可选。
> 5. 阶段 3 元数据扩展降为 P2 可选，不再阻塞主流程。
> 6. PNG 截图区分“固定尺寸卡片”和“长页面”，长页面优先 PDF / Playwright / html2canvas。
> 7. 补充模板路由边界、导出脚本安全细节、check 脚本自身测试、视觉验收卡。

---

## 1. 背景与目标

### 1.1 现状

Sati 已有：

- `assets/templates/patent/`：5 类专利正式文书模板，A4 打印优先，品牌 token 注入，HTML/PDF 渲染。
- `skills/frontend-slides/`：HTML 幻灯片生成技能，含视口适配、动画参考、风格预设。
- `skills/frontend-design/`、`skills/web-design-guidelines/`：通用前端设计原则与审查清单。
- `ui/src/components/code-editor/view/subcomponents/HtmlDocumentPreview.tsx`：iframe 沙箱 HTML 预览。
- `src/patent/document/pdfRenderer.ts`：Chrome headless PDF 打印。

差距：

1. 除幻灯片外，缺少通用 HTML 交付物模板库（数据报告、编辑级长文、海报、社交卡片等）。
2. HTML 设计约束分散在多个 skill 中，没有一份所有 HTML 生成共享的硬性契约。
3. 没有 `example.html` 机制，agent 与用户都缺少可预览、可对标的风格基准。
4. 导出能力主要是 HTML/PDF，缺少公众号 CSS 内联、高 DPI PNG、知乎公式兼容。
5. 没有模板元数据（`mode/scenario/surface/preview/design_system`），后续做模板筛选/UI 展示时缺少基础。
6. 没有针对 HTML 模板的自动化质量检查。

### 1.2 目标

在 0.1.x 版本内落地：

- P0：一份共享 HTML 设计契约，所有 HTML 生成类 skill 统一引用。
- P1：4 个高价值 HTML 交付模板，每个模板 `SKILL.md + example.html + references/checklist.md`。
- P2：HTML 交付导出脚本（公众号内联 / 固定尺寸 PNG / PDF / 知乎兼容）。
- P2：HTML 模板自动化检查，挂入 `pnpm lint`。
- P2：skill frontmatter 元数据扩展（仅在需要 UI 模板筛选时实施）。
- P2：打包分发验证、文档与 QA。

### 1.3 非目标

- 不照搬 html-anything 的全部 75 个模板（社交媒体、营销类模板价值低）。
- 不引入 html-anything 的本地 coding-agent CLI 检测与 Next.js 编辑器产品形态。
- 不改变现有 `assets/templates/patent/` 正式文书风格与 `render_patent_document` 工具。
- 不在本方案内实现模板市场、多模板对比生成等规划特性。
- 不默认修改全局 system prompt 注入 HTML 契约，避免影响 llm-replay 测试体系。

### 1.4 许可证与署名

- 本方案默认**只借鉴方法、约束与结构**，不复制 html-anything 的代码或素材。
- 如果实施过程中确实需要复制/改编任何文件（如某个 `SKILL.md` 或 `example.html` 片段）：
  - 必须保留 html-anything 的 Apache-2.0 声明与作者署名；
  - 在每个模板目录的 `references/SOURCE.md` 中记录来源仓库、原始 skill、改编范围；
  - 在合并前请项目法务确认 AGPL-3.0 与 Apache-2.0 组合方式的合规性。
- 示例数据一律使用 Sati 自有的专利/知识产权场景数据，不使用 html-anything 的示例素材。

---

## 2. 总体架构

### 2.1 目录设计

```text
assets/prompts/html/
├── shared-design-directives.md     # 所有 HTML 生成共享的设计约束（新建）
└── html-delivery-checklist.md      # HTML 交付物通用自查清单（新建）

skills/
├── frontend-design/SKILL.md        # 更新：引用共享设计约束
├── frontend-slides/SKILL.md        # 更新：引用共享设计约束，保留视口规则
├── web-design-guidelines/SKILL.md  # 更新：引用共享设计约束
└── html-<surface>/                 # 新建首批 4 个通用 HTML 交付技能
    ├── SKILL.md                    # 含扩展 frontmatter 元数据（可选）
    ├── example.html                # 单文件 HTML 风格基准
    ├── example.md                  # 示例输入（可选项，用于本地预览）
    └── references/
        ├── checklist.md            # 模板专属自查清单
        └── SOURCE.md               # 来源与署名（借鉴 html-anything 时必填）

scripts/
├── check-html-templates.mjs        # HTML 模板契约检查（新建）
└── export-html.mjs                 # HTML 交付导出脚本（新建，P2）

src/
├── extension/skills/types.ts       # 可选：扩展 SkillSummary 元数据（P2）
├── extension/skills/SkillManager.ts# 可选：readSkillMeta 解析新 frontmatter 字段（P2）
└── tool/builtin/                   # 可选：export_html 内置工具（P2）
```

### 2.2 关键设计决策

1. **通用 HTML 交付物以 skill 形式落地**，不新增模板解析引擎。
   - 复用 Sati 现有 `SkillManager` / `read_skill` / 文件夹导入能力。
   - 模板即 `skills/html-*/SKILL.md`，`example.html` 作为风格基准随 skill 分发。
   - 正式专利文书仍走 `assets/templates/patent/` + `render_patent_document`，二者不混用。

2. **设计约束单一来源，但不改全局 system prompt**。
   - 共享约束写入 `assets/prompts/html/shared-design-directives.md`。
   - 每个 HTML 技能在 `SKILL.md` 中强制要求 agent 先读取该文件。
   - 不通过 `PromptAssembler` 做全局注入，避免改变 `systemPromptDigest` 导致 llm-replay fixture 失配。
   - 如果未来确实需要全局注入，必须单独立项并同步更新/重录 replay fixture。

3. **模板元数据作为 P2 可选能力**。
   - 当前阶段不需要 UI 模板选择器，`mode/scenario/surface` 可先写在 SKILL.md frontmatter 中但不解析。
   - 只有真正需要“模板筛选 / UI 标签展示”时，再扩展 `SkillManager` 与协议。

4. **导出能力先脚本后工具**。
   - 先提供 `scripts/export-html.mjs`，agent 通过 `bash` 调用。
   - 验证稳定后再封装为 `export_html` 内置工具（P2 可选）。

5. **质量检查自动化**。
   - 新建 `scripts/check-html-templates.mjs`，挂入 `pnpm lint`。
   - 检查内容是确定性的：文件存在性、单文件 HTML、无占位符、无外部图片、包含 CJK 字体栈、引用共享约束等。

6. **模板路由边界**。
   - 正式专利文书（意见书、检索报告、OA、权利要求、无效意见）→ `render_patent_document`
   - HTML 幻灯片 / PPT 转换 / 演示 deck → `frontend-slides`
   - 数据报告、长文/客户函、海报、社交卡片 → `html-data-report` / `html-editorial-doc` / `html-poster` / `html-social-card`
   - 用户没有明确类型时，agent 先按内容结构推荐：表格数据多 → `html-data-report`；长文 → `html-editorial-doc`；单页传播 → `html-poster` / `html-social-card`

---

## 3. 阶段任务清单

> 任务编号 `T<阶段>.<序号>`；标注依赖关系与验收标准。
> 估时：阶段 0 半天；阶段 1 半天；阶段 2 2–3 天；阶段 3 1–2 天；阶段 4 1 天；阶段 5 0.5–1 天；阶段 6 1 天。

### 阶段 0：准备与基线

#### T0.1 冻结调研基线

- 产物：`docs/html-deliverables-integration-plan.md`（v1）与 `docs/html-deliverables-integration-plan-v2.md`（本文件）。
- 内容：记录 html-anything 的仓库状态、75 skills / 9 surfaces、`SHARED_DESIGN_DIRECTIVES`、导出管线、许可协议。
- 验收：`pnpm typecheck`、`pnpm lint` 全绿；基线测试通过。

#### T0.2 确定首批模板清单

- 首批 4 个模板：
  1. `html-data-report`：CSV/Excel/JSON → 可视化数据报告（KPI 卡 + Chart.js + 表格 + 洞察）。
  2. `html-editorial-doc`：长报告、法律备忘录、客户函（暖纸底 + 墨蓝单色 + 单一衬线）。
  3. `html-poster`：单页海报（发布会、培训、成果展示，固定尺寸 1080×1920 或 A4）。
  4. `html-social-card`：微信/知乎/社交分享卡（固定尺寸 1600×900 或 1080×1920）。
- P2 可选模板：`html-meeting-notes`、`html-finance-report`、`html-patent-briefing-deck`。
- 验收：模板清单与 README 记录一致。

#### T0.3 打包与分发验证基线

- 检查点：
  - 确认 `resolveBuiltinSkillsRoot` 在源码运行、`pnpm build` 后、Electron 桌面端三种模式下都能解析到新增 `skills/html-*`。
  - 确认 build 脚本是否需要把 `skills/` 或 `assets/prompts/html/` 拷贝到 `dist/`。
  - 确认新增 skill 总大小不超过 SkillManager 限制（单文件 10MB、总 50MB、500 文件）。
- 验收：
  - 三种模式均能通过 `SkillManager.list()` 看到 `html-*`。
  - 安装包/桌面端冒烟测试通过。

---

### 阶段 1：共享 HTML 设计契约（P0）

#### T1.1 新建 `assets/prompts/html/shared-design-directives.md`

- 依赖：T0.1。
- 内容必须覆盖：
  - 输出格式：单文件 HTML、内联 CSS/JS、`<!DOCTYPE html>` 开头、`</html>` 结尾、可直接双击打开。
  - 排版：中文优先 `Noto Sans SC` / `Noto Serif SC`，英文 `Inter` / `Manrope`；正文最大宽度约 65ch。
  - 色彩：1 主色 + 2 中性色 + 最多 1 强调色；不使用纯黑 `#000` / 纯白 `#fff`；对比度 ≥ 4.5。
  - 网格与间距：8px 基线；圆角统一；阴影克制。
  - 动效：仅在必要处使用 `transition` / 入场动画；支持 `prefers-reduced-motion`。
  - 可访问性：语义标签、focus 态、alt 文本、不依赖颜色作为唯一信息通道。
  - 内容真实性：必须使用用户提供的真实数据；禁止 lorem ipsum / “Your text here” / 中文占位符。
  - 内容驱动数量：模板只定义版式池，不定义 section/slide/card 上限；必须完整覆盖用户内容，不压缩、不丢弃。
  - 图表：图表容器必须有固定高度（Chart.js `responsive:true, maintainAspectRatio:false` 需父容器显式高度）。
  - 中英文混排加盘古之白（半角空格）。
- 验收：
  - 文件存在且不超过 120 行。
  - 用 `grep` 可检出 8 个以上约束关键词（如 `单文件`、`#000`、`lorem ipsum`、`65ch`、`对比度`、`prefers-reduced-motion`、`盘古之白`、`固定高度`）。

#### T1.2 新建 `assets/prompts/html/html-delivery-checklist.md`

- 依赖：T1.1。
- 内容：通用 HTML 交付物生成前/生成后检查表。
  - 生成前：确认内容完整性、数据真实性、目标平台（浏览器 / 打印 / 公众号 / 社交图）。
  - 生成后：单文件可打开、无控制台错误、图表高度正常、打印分页正常、移动端可读、对比度达标、无占位符。
- 验收：文件存在；被 T1.3–T1.5 及所有 `html-*` 模板引用。

#### T1.3 更新 `skills/frontend-design/SKILL.md`

- 依赖：T1.1。
- 变更：在 Workflow 第 1 步前插入：“读取 `assets/prompts/html/shared-design-directives.md` 与 `assets/prompts/html/html-delivery-checklist.md`”。
- 验收：`grep -n "shared-design-directives" skills/frontend-design/SKILL.md` 命中。

#### T1.4 更新 `skills/frontend-slides/SKILL.md`

- 依赖：T1.1。
- 变更：保留现有视口适配规则（`viewport-base.css`、`clamp()`、密度上限）；在 Phase 3 “Before generating” 列表中增加共享设计约束与交付清单。
- 验收：`grep -n "shared-design-directives" skills/frontend-slides/SKILL.md` 命中；原有 `viewport-base.css` 要求未被删除。

#### T1.5 更新 `skills/web-design-guidelines/SKILL.md`

- 依赖：T1.1。
- 变更：Checklist 首部增加“读取共享设计约束”，并新增“单文件 HTML 交付物”专项检查段。
- 验收：`grep -n "shared-design-directives" skills/web-design-guidelines/SKILL.md` 命中。

#### T1.6 不在全局 PromptAssembler 注入契约（记录为决策）

- 说明：
  - 为保护 llm-replay fixture 与 `systemPromptDigest` 稳定性，本版本**不修改** `src/context/prompt/PromptAssembler.ts`。
  - HTML 契约通过 skill 内容强制引用。
- 验收：`git diff src/context/prompt/PromptAssembler.ts` 为空；现有 llm-replay 测试不红。

---

### 阶段 2：通用 HTML 交付模板库（P1）

#### T2.1 制定模板目录与 frontmatter 规范

- 依赖：T0.2。
- 目录名：`skills/html-<surface>/`。
- `SKILL.md` frontmatter 至少包含：

```yaml
---
name: html-data-report
description: "..."
mode: data-report
scenario: finance
surface: long-page
preview: example.html
design_system: sati-html
---
```

- 本阶段 frontmatter 先写入，但不要求 `SkillManager` 解析；后续 P2 元数据扩展时再读取。
- `mode` 枚举：`doc | deck | data-report | poster | social-card | prototype | office | frame`。
- `scenario` 枚举：`patent | legal | finance | product | operation | design | personal`。
- `surface` 枚举：`long-page | a4 | 16:9 | 1600x900 | 1080x1920 | auto`。
- 验收：规范写入本文件第 2 节或 `assets/prompts/html/shared-design-directives.md`。

#### T2.2 新建 `skills/html-data-report/`

- 依赖：T2.1。
- 参考：html-anything `next/src/lib/templates/skills/data-report/SKILL.md`（仅借鉴结构，不复制文案）。
- 内容：KPI 卡 3–5 个、主图表 ≥2 个（Chart.js，容器固定高度）、数据表格、3–5 条文字洞察、方法论折叠区。
- 必须适配 Sati：输入来自真实专利/经营数据；示例使用 Sati 自造数据（如「事务所月度案件量」）。
- 验收：目录含 `SKILL.md`、`example.html`、`references/checklist.md`、`references/SOURCE.md`；`example.html` 通过本地打开验证。

#### T2.3 新建 `skills/html-editorial-doc/`

- 依赖：T2.1。
- 参考：html-anything `doc-kami-parchment`（仅借鉴设计方向，不复制代码）。
- 硬性视觉签名：暖羊皮纸 `#f5f4ed`；墨蓝单色 `#1B365D`；单一衬线；行高 1.5–1.55；不用纯白/纯黑；不用阴影/渐变/大圆角。
- 可选文档类型：One-Pager / 长报告 / 客户函 / 备忘录。
- 验收：目录含 `SKILL.md`、`example.html`、`references/checklist.md`、`references/SOURCE.md`；example 与视觉签名一致。

#### T2.4 新建 `skills/html-poster/`

- 依赖：T2.1。
- 参考：html-anything `magazine-poster` / `poster-hero`（仅借鉴布局思路）。
- 内容：固定尺寸 1080×1920 或 A4；超大标题 + 2 栏正文 + 编号区块 + 点阵/几何背景；单文件。
- 验收：目录含 `SKILL.md`、`example.html`、`references/checklist.md`、`references/SOURCE.md`。

#### T2.5 新建 `skills/html-social-card/`

- 依赖：T2.1。
- 参考：html-anything `card-xiaohongshu` / `social-x-post-card`（仅借鉴卡片结构）。
- 内容：固定尺寸 1600×900 或 1080×1920 卡片；标题 + 副标 + 来源 + CTA；适合微信/知乎/社交分享。
- 验收：目录含 `SKILL.md`、`example.html`、`references/checklist.md`、`references/SOURCE.md`。

#### T2.6 每个模板的 `example.html` 必须通过本地打开验证

- 依赖：T2.2–T2.5。
- 验证方式：
  1. 用 Chrome/Safari 直接打开 `example.html`，无控制台报错。
  2. 视口 1440×900 与 390×844 分别截图检查；固定尺寸模板按目标尺寸检查。
  3. 打印预览 A4，检查分页。
  4. 检查是否引用了外部图片或本地相对图片（应无，字体与 CDN 除外）。
- 视觉验收卡（每个模板至少满足）：
  - 字体层级清晰：标题/正文/注释有明显字号与字重差异；
  - 留白充足：无贴边、无拥挤；
  - 颜色数量克制：主色 + 中性色 + ≤1 强调色；
  - 圆角/阴影一致；
  - 数据真实、无占位符；
  - 移动端可读。
- 验收：截图存档到 `docs/design-qa/html-templates/` 或 `design-qa/` 目录。

#### T2.7 增加模板路由说明

- 依赖：T2.2–T2.5。
- 变更：在 README / `html-delivery-checklist.md` 中增加“模板路由表”（见 2.2 第 6 点）。
- 验收：README 可指导 agent 和用户选择正确模板。

---

### 阶段 3：交付导出能力（P2）

#### T3.1 新建 `scripts/export-html.mjs`

- 依赖：T1.1。
- 功能（子命令）：
  1. `node scripts/export-html.mjs wechat <input.html> [output.html]`
     - 使用 `juice` 将 CSS 内联为 style 属性，生成公众号兼容版本。
     - 说明：若 HTML 使用 Tailwind CDN 运行时生成样式，`juice` 无法内联；公众号模板必须使用内联 `<style>` 的静态 CSS。
  2. `node scripts/export-html.mjs png <input.html> [output.png] [--width W --height H]`
     - 适用于固定尺寸模板（poster / social-card）：Chrome `--headless --screenshot=output.png --window-size=W,H --force-device-scale-factor=2`。
     - 长页面（data-report / editorial-doc）不承诺 PNG 全页截图；如需要 full-page PNG，使用 Playwright 或前端 `html2canvas`，并在文档中标注限制。
  3. `node scripts/export-html.mjs pdf <input.html> [output.pdf]`
     - 复用 Chrome `--print-to-pdf`，A4 边距默认 16mm/18mm。
     - 长页面默认推荐 PDF，而不是 PNG。
  4. `node scripts/export-html.mjs zhihu <input.html> [output.html]`
     - 将 `<mjx-container>` 替换为 `data-eeimg` 占位，兼容知乎公式图片化。
  5. `node scripts/export-html.mjs check <input.html>`
     - 调用 `scripts/check-html-templates.mjs` 的单文件模式，输出 pass/fail。
- 安全要求：
  - 输入路径必须存在且为普通文件；
  - 输出路径必须经过安全校验，拒绝 `..`、绝对路径写入危险目录；
  - 无 Chrome 时返回可读错误，不 panic；
  - 所有子命令支持 `--help`。
- 验收：
  - 对 `skills/html-data-report/example.html` 执行 `wechat`、`pdf` 均成功。
  - 对 `skills/html-social-card/example.html` 执行 `png` 成功。
  - 对 `skills/html-editorial-doc/example.html` 执行 `zhihu` 成功。
  - 产物可打开，路径安全校验有测试。

#### T3.2 新增依赖 `juice`

- 变更：根 `package.json` dependencies 增加 `juice`（版本以 `pnpm add juice` 为准，锁定在 lockfile）。
- 验收：`pnpm install --frozen-lockfile` 后脚本可运行；`pnpm audit` 不新增高危项。

#### T3.3 可选：新增 `export_html` 内置工具

- 依赖：T3.1 稳定。
- 文件：`src/tool/builtin/exportHtml.ts`。
- 工具契约：`name: "export_html"`，`domain: "html"`，`inputSchema` 含 `html_path`、`targets: ["wechat","png","pdf","zhihu"]`、`output_dir?`。
- 注册：`src/tool/registry/createBuiltinRegistry.ts` 中注册；默认注册。
- 验收：
  - 工具单测覆盖 `wechat`/`png`/`pdf` 成功路径与非法路径错误码。
  - `pnpm typecheck`、`pnpm lint` 通过。
  - `check:event-matrix` 通过（新增工具若影响事件矩阵，同步更新文档）。
  - 注意：新增工具会改变 `toolSchemaDigest`，如仓库已有 llm-replay fixture 涉及 `export_html`，需同步重录 fixture；未涉及则不受影响。

#### T3.4 微信公众号粘贴兼容测试

- 依赖：T3.1。
- 验证：将 `wechat` 产物粘贴到公众号编辑器，样式保留；图片/表格不丢。
- 验收：至少 1 个模板（`html-data-report`）通过，截图存档。

---

### 阶段 4：自动化质量检查（P2）

#### T4.1 新建 `scripts/check-html-templates.mjs`

- 依赖：T2.2–T2.5。
- 检查逻辑：
  1. 扫描 `skills/` 下所有 `SKILL.md`；仅检查 `mode` 存在 或 slug 以 `html-` 开头的技能。
  2. 每个 HTML 模板必须包含：
     - `SKILL.md`
     - `example.html`
     - `references/checklist.md`
     - 若借鉴 html-anything，`references/SOURCE.md` 或 `LICENSE`
  3. `SKILL.md` 必须引用 `assets/prompts/html/shared-design-directives.md`。
  4. `example.html` 硬性检查：
     - 以 `<!DOCTYPE html>` 开头，以 `</html>` 结尾（允许尾部空白）。
     - 必须有 `lang` 属性（不强制 `zh-CN`，但推荐）。
     - 包含 CJK 字体栈（`Noto Sans SC` 或 `Noto Serif SC` 或 `Source Han`）。
     - 不包含明确占位模式：`lorem ipsum`（大小写不敏感）、`Your text here`、`TODO:`、`TODO（`。
     - 不包含本地图片相对路径（`src="./`、`src="images/` 等）；`http(s)` 图片允许但输出 warning。
     - 文件大小 ≤ 5MB。
  5. 单文件模式：`node scripts/check-html-templates.mjs <input.html>` 只做第 4 步的 1/4/5 项。
  6. 输出 `Checked N html templates` 与问题列表；hard 问题 exit 1，warning exit 0。
- 验收：
  - 对当前 4 个模板运行通过。
  - 人为注入 `lorem ipsum` 后脚本 exit 1。
  - 缺失 `references/checklist.md` 后脚本 exit 1。

#### T4.2 新建 check 脚本自身测试

- 文件：`tests/scripts/check-html-templates.test.mjs`（或 `scripts/__tests__/`）。
- 覆盖：
  - 正常模板目录通过；
  - 缺少 `example.html` 失败；
  - 缺少共享约束引用失败；
  - 注入 lorem ipsum 失败；
  - 单文件模式对普通 HTML 文件通过。
- 验收：`node --test tests/scripts/check-html-templates.test.mjs` 通过。

#### T4.3 挂载到 `pnpm lint`

- 变更：根 `package.json` `lint` 脚本末尾增加 `&& node scripts/check-html-templates.mjs`。
- 验收：`pnpm lint` 全绿；CI（若有）不红。

#### T4.4 新增导出脚本单测

- 依赖：T3.1。
- 文件：`tests/scripts/export-html.test.mjs`（或 `scripts/__tests__/`）。
- 覆盖：`wechat` 内联成功；`pdf` 在无 Chrome 时优雅降级并返回非 0；`zhihu` 替换 `mjx-container`；路径安全校验拒绝 `..`。
- 验收：`node --test tests/scripts/export-html.test.mjs` 通过。

---

### 阶段 5：skill 元数据扩展（P2 可选）

> 仅在确认需要 UI 模板筛选 / 技能标签展示时实施；否则跳过本阶段。

#### T5.1 扩展 `src/extension/skills/types.ts`

- 变更：`SkillSummary` 增加可选字段：

```ts
export type SkillTemplateMeta = {
  mode?: "doc" | "deck" | "data-report" | "poster" | "social-card" | "prototype" | "office" | "frame";
  scenario?: "patent" | "legal" | "finance" | "product" | "operation" | "design" | "personal";
  surface?: "long-page" | "a4" | "16:9" | "1600x900" | "1080x1920" | "auto";
  preview?: string;
  designSystem?: string;
};

export type SkillSummary = {
  // ...现有字段
  template?: SkillTemplateMeta | null;
};
```

- 验收：`pnpm typecheck` 通过；新字段导出到 `src/extension/skills/index.ts`（如需要）。

#### T5.2 更新 `src/extension/skills/SkillManager.ts`

- 变更：`parseSkillFrontmatter` / `readSkillMeta` 读取并校验 `mode/scenario/surface/preview/design_system`；
  - 未知枚举值降级为 `undefined`，不阻断加载。
  - `preview` 若填写，必须通过 `isValidRelativePath`（不含 `..`，不以 `/` 开头）。
- 验收：
  - `pnpm typecheck` 通过。
  - 新增单测：`tests/extension/skills/SkillManager.template-meta.test.ts`（或现有测试目录）覆盖解析、非法值降级、preview 路径校验。

#### T5.3 更新 `scripts/validate-skills.mjs`

- 变更：读取新 frontmatter 字段并输出警告：
  - `mode` 存在但不在枚举内 → warn。
  - `preview` 存在但文件缺失 → hard（仅对 `html-*` 模板）。
- 验收：`node scripts/validate-skills.mjs` 在新增模板后通过或仅产生可解释的 warning。

#### T5.4 UI 层展示模板元数据

- 变更：`ui/src/components/skills/` 相关组件在技能详情中显示 `mode/scenario/surface` 标签。
- 验收：UI 截图可见标签；`pnpm --filter sati-ui typecheck` 通过。

---

### 阶段 6：文档、QA 与收口

#### T6.1 更新 README / 文档

- 变更：
  - `README.md` / `README.zh.md`：新增「HTML 交付物」小节，列出 4 个模板、共享设计契约、导出脚本用法、模板路由表。
  - `CLAUDE.md`：目录结构增加 `assets/prompts/html/` 与 `scripts/export-html.mjs`、`scripts/check-html-templates.mjs`。
  - `docs/` 本方案文件保持更新。
- 验收：README 中示例命令可运行。

#### T6.2 端到端 QA

- 依赖：阶段 1–4 完成。
- QA 场景：
  1. 用真实专利场景输入对 4 个模板各生成一份 HTML（至少一个模板用真实 CSV 数据）。
  2. 在浏览器打开，检查 1440×900 / 390×844 两个视口。
  3. 用 `scripts/export-html.mjs` 导出 wechat/png/pdf，并逐项检查。
  4. 用 `frontend-slides` 生成一份 deck，确认仍满足视口规则且引用新共享契约。
  5. 用 `render_patent_document` 生成一份专利文书，确认不受影响。
- 验收：截图存档到 `design-qa/html-templates/`；问题清单清零或仅剩已登记的 P2 问题。

#### T6.3 打包与分发验收

- 依赖：T0.3。
- 检查：
  - 源码运行、`pnpm build` 后、Electron 桌面端均能读取 `skills/html-*`。
  - 安装包中包含 `assets/prompts/html/`（如需随包分发）。
  - 新增 skill 总大小不超 SkillManager 限制。
- 验收：三种模式冒烟测试通过。

#### T6.4 性能与安全复核

- 检查：
  - 新增 skill 总大小不超 SkillManager 限制（单文件 10MB、总 50MB、500 文件）。
  - `example.html` 不包含恶意脚本；iframe 预览继续使用 sandbox。
  - 导出脚本不引入任意文件读取漏洞（路径规范化、拒绝 `..`）。
  - `pnpm audit` 无新增高危。
- 验收：`pnpm lint`、`pnpm typecheck`、`pnpm test` 全绿；`pnpm format:check` 通过。

#### T6.5 回滚方案

- 回滚点：
  - 阶段 1 回滚：删除 `assets/prompts/html/` 与 3 个 skill 的引用行。
  - 阶段 2 回滚：删除 `skills/html-*` 目录。
  - 阶段 3 回滚：删除 `scripts/export-html.mjs`、`juice` 依赖；还原 `package.json`。
  - 阶段 4 回滚：删除 `scripts/check-html-templates.mjs` 及其 lint 挂载。
  - 阶段 5 回滚：还原 `types.ts` / `SkillManager.ts` 到基线提交。
- 验收：每个阶段提交可独立 revert；回滚后 `pnpm lint` / `pnpm typecheck` 仍绿。

---

## 4. 检查清单

### 4.1 共享设计约束检查清单

- [ ] 单文件 HTML：`<!DOCTYPE html>` 开头，`</html>` 结尾，CSS/JS 内联
- [ ] 中文优先 `Noto Sans SC` / `Noto Serif SC`；英文 `Inter` / `Manrope`
- [ ] 8px 基线网格；正文最大宽度约 65ch
- [ ] 1 主色 + 2 中性色 + ≤1 强调色；无纯黑 `#000` / 纯白 `#fff`
- [ ] 颜色对比度 ≥ 4.5
- [ ] 圆角统一；阴影克制；无无意义渐变/霓虹
- [ ] 动效克制；支持 `prefers-reduced-motion`
- [ ] 语义化标签；交互元素有 focus 态；图片有 alt
- [ ] 必须使用真实数据；无 `lorem ipsum` / “Your text here” / 中文占位符
- [ ] 内容驱动数量；不压缩、不丢弃用户内容
- [ ] 图表容器有固定高度（Chart.js/ECharts）
- [ ] 中英文混排加盘古之白（半角空格）
- [ ] 不引用本地/外部图片（CSS/SVG 内联绘制优先）

### 4.2 模板目录检查清单

- [ ] `SKILL.md` 存在且 frontmatter 含 `name`、`description`
- [ ] frontmatter 含 `mode/scenario/surface/preview/design_system`（先写入，P2 再解析）
- [ ] `example.html` 存在且通过 4.1 检查
- [ ] `references/checklist.md` 存在
- [ ] 借鉴来源时 `references/SOURCE.md` 或 `LICENSE` 存在并署名
- [ ] `SKILL.md` 引用 `assets/prompts/html/shared-design-directives.md`
- [ ] `SKILL.md` 中「硬性视觉签名」明确、可执行、可验证
- [ ] 模板示例数据为 Sati 自有专利/专业服务场景

### 4.3 example.html 检查清单

- [ ] 可直接双击打开，无控制台错误
- [ ] 1440×900 与 390×844 视口可读（固定尺寸模板按目标尺寸检查）
- [ ] A4 打印预览分页正常
- [ ] 无外部图片依赖（字体/图表 CDN 除外）
- [ ] 图表容器高度固定
- [ ] 无 lorem ipsum / 占位文案
- [ ] 文件大小 ≤ 5MB
- [ ] 标题层级、表格、徽章等组件符合模板规范

### 4.4 导出能力检查清单

- [ ] `wechat` 子命令可生成 CSS 内联版本
- [ ] `png` 子命令可对固定尺寸模板生成 2× PNG，且无白屏/截断
- [ ] 长页面模板不承诺 PNG 全页，默认用 PDF
- [ ] `pdf` 子命令可生成 A4 PDF
- [ ] `zhihu` 子命令可替换 `mjx-container` 为 `data-eeimg`
- [ ] 无 Chrome 时优雅报错，不挂起
- [ ] 输出文件名安全，拒绝路径穿越
- [ ] 各子命令有 `--help`

### 4.5 自动化检查脚本检查清单

- [ ] 扫描范围正确（`html-*` 或 `mode` 存在的 skill）
- [ ] 文件存在性、共享约束引用、example.html 硬性检查全部覆盖
- [ ] 单文件模式可用
- [ ] check 脚本自身有单测
- [ ] 挂入 `pnpm lint`
- [ ] 注入违规示例后 exit 1

### 4.6 打包与分发检查清单

- [ ] 源码运行可读取 `skills/html-*`
- [ ] `pnpm build` 后 dist/生产模式可读取 `skills/html-*`
- [ ] Electron 桌面端可读取 `skills/html-*`
- [ ] 安装包包含 `assets/prompts/html/`（如需随包分发）
- [ ] 新增 skill 总大小不超 SkillManager 限制

### 4.7 最终验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过（含新增 check 脚本）
- [ ] `pnpm test` 通过
- [ ] `pnpm format:check` 通过
- [ ] 4 个 `skills/html-*` 模板全部通过 `scripts/check-html-templates.mjs`
- [ ] 至少 1 个模板完成真实数据端到端生成 + wechat/png/pdf 导出
- [ ] 现有 `frontend-slides` / `frontend-design` / `web-design-guidelines` 引用新契约
- [ ] 现有 `render_patent_document` 回归通过
- [ ] 源码/生产/Electron 三模式冒烟通过
- [ ] README / CLAUDE.md 文档更新完成

---

## 5. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 新模板与现有 `frontend-slides` 风格冲突 | 中 | 中 | 共享约束优先；模板专属风格在 SKILL.md 内声明，冲突时以共享约束为准 |
| `example.html` 过大拖慢仓库/skill 导入 | 中 | 低 | 单文件 ≤5MB；图表 CDN 不内联库；校验脚本硬限制 |
| `juice` 内联对 Tailwind CDN 生成的 HTML 效果有限 | 高 | 中 | 公众号场景优先使用内联 CSS 模板；文档说明 Tailwind CDN 不适合公众号直投 |
| Chrome 截图在无 Chrome 环境失败 | 中 | 低 | 复用 `SATI_CHROME_PATH` / 候选路径；无 Chrome 时输出可读错误，不阻断主流程 |
| 长页面 PNG 截图不完整 | 中 | 中 | 长页面默认 PDF；full-page PNG 使用 Playwright / html2canvas，并在文档标注限制 |
| 元数据扩展影响 UI/网关协议 | 低 | 中 | 字段全部可选；未知字段被 YAML 解析器忽略；协议测试覆盖；本阶段为 P2 可选 |
| 全局提示注入破坏 llm-replay | 低 | 高 | 本方案不修改 PromptAssembler；如需全局注入，单独立项并重录 fixture |
| 版权/署名遗漏 | 低 | 高 | 每个借鉴模板必须有 `SOURCE.md`；`check-html-templates.mjs` 检查 `html-*` 目录的署名文件 |
| 打包遗漏新 skills/assets | 中 | 高 | T0.3 与 T6.3 强制做源码/生产/Electron 三模式验证 |

---

## 6. 里程碑

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M1 | 阶段 0–1：共享设计契约 | 3 个现有 skill 引用新契约；`pnpm lint` 绿；不修改 PromptAssembler |
| M2 | 阶段 2：4 个 HTML 模板 | 4 个模板通过本地打开与截图 QA |
| M3 | 阶段 3–4：导出与检查 | `wechat/png/pdf` 跑通；check 脚本挂 lint 且自带测试 |
| M4 | 阶段 6：文档与 QA | 最终验收清单全部勾选；三模式冒烟通过 |

> 说明：M4 的验收口径为 **`scripts/export-html.mjs` 必需**；`export_html` 内置工具为 P2 可选增强，不阻塞 M4。

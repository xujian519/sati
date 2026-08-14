# 可专利性分析意见 — 版式惯例（Conventions）

> 生成或修改本模板的 HTML 前必读。以下为 P0/P1 级硬性约定，与 `checklist.md` 配套。
> 借鉴 Open Design `design-templates/ib-pitch-book` 的 conventions 模式，面向专利律师文书场景。

## 1. 文书结构（固定顺序，不可增删段落）

1. 页眉（所名 + 密级）
2. 文书抬头（类型徽标 / 标题 / 文档编号）
3. 案件信息表（委托方 / 发明名称 / 案卷号 / 分析依据 / 日期）
4. 一、结论摘要（表 1 + 总体意见 callout）
5. 二、分析依据与判断标准
6. 三、技术方案解析（表 2 特征分解）
7. 四、逐特征比对（表 3，含 pin-cite 与置信度列）
8. 五、创造性判断（三步法 5.1/5.2/5.3）
9. 六、其他授权要件（表 4）
10. 七、证据与对比文件清单（表 5）
11. 八、引用日志（表 6）
12. 九、假设与局限
13. 落款（分析人 / 审核人）+ 免责声明 + 页脚

理由：结论摘要前置（律师与客户只看第一页即可决策），证据与溯源后置（不打断正文论证流）。

## 2. 编号层级与法条引用

- 编号层级：`一、 → （一） → 1. → （1） → ①`，逐级缩进，不得跳级（对齐 `skills/patent-agent/references/output-standards.md`）。
- 法条引用统一：《专利法》第22条第2款；《专利法实施细则》第XX条；《专利审查指南》第X部分第X章第X节。禁止"根据专利法的相关规定"式模糊表述。
- 对比文件编号：首次全称 + 公开号 +"下称 D1"，后续统一 D1/D2/D3。

## 3. 表格式证据映射（表 3 固定列）

| 列 | 要求 |
|---|---|
| 特征 | 与表 2 特征编号一致（F1/F2…） |
| 本申请特征 | 引用权利要求原文表述，不 paraphrase |
| D1 对应内容 | 逐字摘录原文，禁转述；引文用引号 |
| 引证定位 | `D1 ¶0023` 格式（pin-cite：公开号 + 段号/行号），段号必须真实存在于来源文件，禁止凭记忆编造 |
| 是否公开 | 公开 / 未公开 / 部分公开（三种取值） |
| 置信度 | 证据支撑 / 客户提供 / 模型推断 / 假设（见 §5） |

## 4. 视觉与版式纪律（防"AI 味"）

- **禁 emoji 作为图标/强调**——正式文书用文字或 monoline SVG。
- **禁营销式渐变、圆角卡片、彩色浮层**——文书是线性文档，层级靠标题字号与边框，不靠背景块。
- **主色仅用 `--doc-accent`（藏蓝）**：标题、表头、callout 左边框。红色仅用于"风险高/不具备"徽标，绿色仅用于"具备"。
- **正文中文用宋体（`--doc-font-serif`），标题用黑体（`--doc-font-sans`）**；不引入无衬线营销字体（Inter/Roboto 等）。
- 表格数字列用 `tabular-nums`（骨架已内置 `font-variant-numeric`）。
- 数据要么来自真实来源，要么明确标注"假设"并斜体（`assumption-note`）——**禁止编造公开号、日期、引用段落**。
- 每屏 accent 使用克制：正文不出现彩色强调文字（链接/断言不用色）。

## 5. 置信度徽标语义（与 `citation-log.md` 四字段一致）

| 徽标 | 含义 | 渲染 |
|---|---|---|
| `badge-evidence` 证据支撑 | 断言有来源文件 + pin-cite 支撑 | 藏蓝实线边框 |
| `badge-client` 客户提供 | 来源为客户提供的材料 | 灰实线边框 |
| `badge-model` 模型推断 | 模型推理，无直接文献支撑 | 灰虚线边框 |
| `badge-assumption` 假设 | 无法溯源的填充/默认值 | 灰虚线边框 + 斜体 |

规则：**无任何来源支撑的断言，要么删、要么降级为"假设"**（对齐 ib-pitch-book 的 citation-log 纪律）。

## 6. 风险徽标

- 具备 / 风险低 → `badge-risk-low`（绿）
- 存疑 / 风险中 → `badge-risk-mid`（橙）
- 不具备 / 风险高 → `badge-risk-high`（红）

## 7. 打印导出（A4 PDF）

骨架已含 `@page { size: A4 }` 与跨页表头重复（`thead { display: table-header-group }`）。页号由导出管线注入，不要在 HTML 里手工写页码。导出示例（复用 `skills/frontend-slides/scripts/export-pdf.sh` 的 Playwright 基建，改为文档模式）：

```js
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${path}/patentability-opinion.html`);
await page.pdf({
  path: "patentability-opinion.pdf",
  format: "A4",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate:
    '<div style="font-size:9px;width:100%;padding:0 18mm;color:#6b6b6b;">XX 知识产权代理事务所 · 机密</div>',
  footerTemplate:
    '<div style="font-size:9px;width:100%;padding:0 18mm;color:#6b6b6b;display:flex;justify-content:space-between;">' +
    '<span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</span>' +
    '<span>PA-2026-XXXX</span></div>',
  margin: { top: "16mm", bottom: "18mm", left: "18mm", right: "18mm" },
});
await browser.close();
```

注意：中文字体依赖系统字体（macOS 宋体/黑体 fallback 可用；Linux 需预装 Noto CJK 或在导出机配置）。`@page` margin 与 `page.pdf()` margin 取一致值，避免页眉页脚与正文重叠。

## 8. 品牌契约注入点

品牌常量统一走 `assets/templates/patent/tokens.css` 中的 `--sati-doc-*` 变量：

| 变量 | 用途 |
|---|---|
| `--sati-doc-firm` | 抬头事务所名 |
| `--sati-doc-confidential` | 密级/状态文案 |
| `--sati-doc-disclaimer` | 免责声明全文 |
| `--sati-doc-accent` / `--sati-doc-accent-strong` | 主色/深主色 |
| `--sati-doc-font-serif` / `--sati-doc-font-sans` / `--sati-doc-font-mono` | 字体族 |

HTML 内已改为 `content: var(--doc-firm)` 等伪元素注入，因此**事务所名、密级、免责声明文本也由 CSS 变量控制**，无需 agent 修改 HTML 文本。

按产品/事务所覆盖方式：

1. 在 `products/<标识>/brand/theme.json` 的 `documents.patent` 命名空间声明覆盖（见 `products/_example/brand/theme.json`）。
2. 渲染管线把覆盖值写入输出 HTML 的 `<style>` 块（覆盖 `--sati-doc-*`）。
3. agent 不直接改样式或抬头文本；只填充案件内容与结论。

默认未覆盖时使用 `tokens.css` 中的占位值（XX 事务所）。交付前必须确认已正确注入真实事务所品牌。

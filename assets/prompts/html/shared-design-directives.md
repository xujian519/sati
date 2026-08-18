# Sati HTML 交付物共享设计约束

> 适用范围：Sati 生成的所有非正式文书类 HTML 交付物（数据报告、长文/客户函、海报、社交卡片、网页原型、幻灯片等）。
> 正式专利文书走 `assets/templates/patent/` + `render_patent_document`，不适用本文件。

## 输出格式

- 输出必须是**自包含单文件 HTML**：`<!DOCTYPE html>` 开头，`</html>` 结尾。
- CSS 与 JS 全部内联；可引用 CDN（字体、图表库），但不得依赖本地相对资源。
- 文件应可直接双击打开，不依赖构建工具或本地服务。

## 字体与排版

- 中文优先：`Noto Sans SC` / `Noto Serif SC` / `Source Han Sans SC` / `Source Han Serif SC`。
- 英文优先：`Inter` / `Manrope` / `SF Pro`。
- 正文最大宽度约 `65ch`，行高不低于 1.5（阅读型正文建议 1.6–1.8）。
- 使用 8px 基线网格；字号、间距、圆角尽量落在 8px 节奏上。
- 中英文混排时，中英文之间保留半角空格（盘古之白）。

## 色彩

- 使用 1 个主色 + 2 个中性色 + 最多 1 个强调色。
- 禁止使用纯黑 `#000` / 纯白 `#fff`；建议使用 `#0a0a0a` / `#fafafa` 级别颜色。
- 文字与背景对比度 ≥ 4.5（大字号可放宽到 3:1）。
- 语义色（成功/警告/危险）不得作为唯一信息通道，必须配合文字/图标。

## 网格与视觉细节

- 布局有明确的网格或对齐关系，避免随意堆叠。
- 圆角统一，阴影克制（优先 `shadow-sm` / 1px 边框）。
- 不使用无意义的大渐变、霓虹色、玻璃拟态堆砌。

## 动效

- 仅在必要处使用 `transition` 或入场动画，避免喧宾夺主。
- 必须支持 `prefers-reduced-motion: reduce`。

## 可访问性

- 使用语义化标签（`header` / `main` / `section` / `nav` / `table` 等）。
- 交互元素必须有可见 focus 态。
- 图片必须有 `alt`；图标使用 `aria-hidden`。
- 不依赖颜色作为唯一信息通道。

## 内容真实性

- **必须使用用户提供的真实数据**，禁止 `lorem ipsum`、`Your text here`、中文占位符。
- 如果输入是 CSV/Excel/JSON，应提取真实数据并可视化。
- 模板只定义版式池，不定义 section/slide/card 数量上限；内容多就多页/多 section，不压缩、不丢弃。

## 图表

- 图表容器必须有固定高度；Chart.js/ECharts 使用 `responsive: true, maintainAspectRatio: false` 时父容器必须显式设置高度，否则会卡死浏览器。
- 图表配色使用模板调色板，不混入无关颜色。

## 禁止项

- 禁止引用本地图片（`src="./x.png"`、`src="images/x.png"`）；优先 CSS/SVG 内联绘制。
- 禁止使用未验证的外部图片 URL。
- 禁止输出 Markdown 代码围栏包裹的 HTML；第一个字符必须是 `<`。
- 禁止在 HTML 中写入“我来生成”“已输出至”等解释性文字。

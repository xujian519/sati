---
name: html-editorial-doc
description: 生成编辑级长文、法律备忘录、客户函或 one-pager。暖纸底 + 墨蓝单色 + 单一衬线，适合正式阅读与打印。
mode: doc
scenario: legal
surface: a4
preview: example.html
design_system: sati-html
---

# HTML 编辑级文档模板

将长文/备忘录/客户函渲染为“被排过版的纸”，而不是网页 dashboard。设计方向参考 html-anything 的 `doc-kami-parchment`。

## 前置

- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/shared-design-directives.md`（即仓库根 `assets/prompts/html/shared-design-directives.md`）。
- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/html-delivery-checklist.md`。
- 再读取本目录 `references/checklist.md`。

## 硬性视觉签名

- 画布：暖羊皮纸 `#f5f4ed`，次级背景 `#efeee5`，永远不用纯白 `#fff`。
- 墨色：主文字 `#1f1d18`，次文字 `#6b665b`，不用纯黑 `#000`。
- 唯一色彩：墨蓝 `#1B365D`，所有 accent 只允许这一个色。
- 字体：中文用 `Noto Serif SC` / `Source Han Serif SC`，英文用 `Charter` / `Source Serif Pro`。
- 行高：标题 1.1–1.3，正文 1.5–1.55。
- 禁止：drop-shadow / blur / 圆角 ≥ 8px / 渐变 / 霓虹色 / rgba 背景（用 solid hex）。

## 可选文档类型

- One-Pager：顶部 logotype + 标题 + lede + 3 列要点 + 底部元数据。
- Long Doc：封面页 + 目录 + 章节 + 脚注 + 文末 colophon。
- Letter：抬头地址 + 日期 + 收件人 + 正文 + 署名。
- Memo：标题 + 日期 + 收件人/发件人 + 背景 + 分析 + 结论。

## 输出

- 单文件 HTML，适合 A4 打印。
- 不用外链图片；占位用纸色块 + 1px 墨线描边。
- 文字层级靠衬线对比 + 字号 + 留白，不靠颜色。

# Sati HTML 交付物通用自查清单

> 生成 HTML 前与生成后各执行一次。

## 生成前

- [ ] 明确交付类型：数据报告 / 长文 / 海报 / 社交卡 / 幻灯片 / 网页原型。
- [ ] 确认用户内容完整：数据、章节、列表、来源全部拿到。
- [ ] 确认目标平台：浏览器 / 打印 / 公众号 / 社交图片。
- [ ] 读取 `assets/prompts/html/shared-design-directives.md`。
- [ ] 若使用模板，读取对应 `skills/html-*/SKILL.md` 与 `references/checklist.md`。

## 生成后

- [ ] 单文件 HTML，可直接双击打开。
- [ ] 无控制台错误。
- [ ] 图表容器高度固定，无无限增高/卡死。
- [ ] 1440×900 与 390×844 视口可读。
- [ ] 固定尺寸模板（海报/社交卡）在目标尺寸下无溢出。
- [ ] A4 打印预览分页正常（长文档）。
- [ ] 对比度达标，交互元素有 focus 态。
- [ ] 无 lorem ipsum / 占位文案。
- [ ] 数据真实，无编造数字。
- [ ] 中英文混排有盘古之白。
- [ ] 无外部图片依赖（字体/图表 CDN 除外）。

## 模板路由

| 交付物 | 使用方式 |
|---|---|
| 正式专利文书 | `render_patent_document` |
| HTML 幻灯片 / PPT 转换 | `skills/frontend-slides` |
| 数据报告 | `skills/html-data-report` |
| 长文 / 客户函 / 备忘录 | `skills/html-editorial-doc` |
| 单页海报 | `skills/html-poster` |
| 微信 / 知乎 / 社交分享卡 | `skills/html-social-card` |

# HTML 模板视觉 QA 记录

> 生成日期：2026-08-19
> 方式：Chromium 浏览器直接打开 `skills/html-*/example.html` 并截图。
> 说明：当前沙箱环境无法调用系统 Chrome headless 命令行导出 PNG/PDF（sandbox 权限受限），
> 因此 PNG/PDF 导出使用脚本在其他正常桌面环境验证；本目录仅记录浏览器渲染截图。

## 截图清单

| 模板 | 截图 | 状态 |
|---|---|---|
| html-data-report | `data-report.png` | ✅ 已截图 |
| html-editorial-doc | `editorial-doc.png` | ✅ 已截图 |
| html-poster | `poster.png` | ✅ 已截图 |
| html-social-card | `social-card.png` | ✅ 已截图 |
| html-meeting-notes | `meeting-notes.png` | ✅ 已截图 |
| html-finance-report | `finance-report.png` | ✅ 已截图 |
| html-patent-briefing-deck | `patent-briefing-deck.png` | ✅ 已截图（首页） |

## 已通过的自动化检查

- `node scripts/check-html-templates.mjs`：7 个模板全部通过
- `pnpm lint`：通过（含 `check:html-templates`）
- `pnpm typecheck`：通过
- `pnpm build`：通过
- WeChat 内联导出：7 个模板均成功生成 `*-wechat.html`

## 待人工验证

- 微信公众号编辑器实际粘贴效果
- 知乎公式图片化实际发布效果
- 系统 Chrome headless PNG/PDF 在正常桌面环境的导出效果

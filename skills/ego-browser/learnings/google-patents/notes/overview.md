# Google Patents 站点要点

Google Patents（patents.google.com）是 Sati 专利检索/下载的首选在线源。使用 ego-browser 访问时注意：

## 页面行为

- **SPA 渲染**：检索页结果异步渲染。`openOrReuseTab` 的 `wait` 只保证导航事件，结果需额外等待 `search-result` 元素出现（本包工具已内置等待；手写脚本用 `locator("search-result").first().waitFor(...)` 或短轮询）。
- **URL 校验**：打开 `/patent/<号>` 后，若复用 tab 需校验 `location.href` 确含 `/patent/<号>`（大小写不敏感，按 `/` 或 `?` 边界判定），避免 SPA 未跳转时把上一篇的数据错配给本篇。
- **检索语法**：关键词、布尔（AND/OR/NOT）、`assignee:(Name)`、`inventor:(Name)`、`after:YYYYMMDD` / `before:YYYYMMDD`、专利号直查。

## 选择器（2025+ 页面结构）

- 结果行：`search-result`（自定义元素）
- 标题：`h3.result-title` / `.title-text`；公开号：`.publication_number` / `[itemprop='publicationNumber']`
- 申请人：`.assignee` / `[itemprop='assigneeOriginal']`；日期：`.priority_date` / `.filing_date` / `time`
- 著录页：schema.org `itemprop` 属性齐全（inventor/assigneeOriginal/filingDate/publicationDate/status/abstract）

## PDF 下载

- 专利页内 PDF 链接形如 `https://patentimages.storage.googleapis.com/.../*.pdf`（或 `storage.googleapis.com`）。
- 下载优先用浏览器下载拦截（`page.waitForEvent("download")` + `saveAs`，复用登录态/Cookie），其次才提取 CDN URL 另路下载。
- 已封装为 Sati 内置工具 `patent_pdf_download`（批量 + 进度 + 可选录屏留证）。

## 礼貌与稳定性

- 批量任务复用同一 task space（`openOrReuseTab` 复用 tab），不要每篇重建浏览器进程。
- 页面打开超时建议 20-30s；批量整体预留 `30s + 每篇 20s`。
- 中国大陆网络：ego-browser 可直接访问 Google Patents，无需代理。

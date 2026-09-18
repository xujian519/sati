---
name: ego-browser
description: 基于 Chromium 的浏览器自动化技能（ego-browser/ego-lite），用于打开网页、填写表单、点击、截图、提取页面数据、测试 Web 应用等需要真实浏览器交互的场景；本目录记录各类任务的注意点与可复用步骤。
---

# ego-browser

浏览器自动化操作说明与学习笔记（`learnings/` 目录存放按任务分类的踩坑与可复用片段）。适用于真实浏览器场景：登录后操作、表单填写、截图、页面数据抓取、Web 应用验证等。

用 `ego_browser` 工具执行脚本，本技能提供 helper API 与范例。

## heredoc 调用形态

`ego_browser` 的 `script` 是 `ego-browser nodejs` heredoc 的正文：一段 Node.js 程序。所有 ego-browser helper 已预加载，**最终结果必须用 `cliLog(...)` 打印**——只有 `cliLog` 的输出会回到你这里。

## Helper API

- 任务空间：`useOrCreateTaskSpace(name)`（返回 task）、`completeTaskSpace(id, { keep: false })`、`listTaskSpaces`
- 导航：`openOrReuseTab(url, { wait: true, timeout: 30 })`、`gotoAndWait`、`pageInfo()`、`snapshotText()`（带 refs/locators 的语义树）
- 交互：`click('@N' | css | loc=...)`、`fillInput`、`typeText`、`pressKey`、`scrollBy`、`uploadFile`
- 求值：`js('(() => {...})()')`（在页面内执行）、`cdp(...)`、`serverFetch`、`browserFetch`
- 输出：`cliLog(value)`——唯一的数据回传通道；`help(name)` 打印用法

Playwright 风格 `page` 门面（绑定当前标签页）：`page.goto(url)`、`page.url()`、`page.locator(css)` / `page.getByText(...)`、`page.waitForLoadState('load')`、`page.screenshot({ path })`、`page.waitForEvent('download')`（返回 `{ saveAs(path), url(), suggestedFilename() }`——浏览器内下载拦截，下载 PDF/文件时优先用它，不要猜 CDN URL）、`page.screencast.start({ path, size })` / `page.screencast.stop()`（录制过程留证）、`page.keyboard.press`、`page.mouse.click`。

站点技能：`site.runTool(siteId, toolName, args)` 运行打包好的站点工具（如 google-patents）；`site.skills(url)` 列出该 URL 可用的站点工具。

并行：多个任务空间可并发——建多个空间后 `await Promise.all([...])` 同时抓取/检索多个站点；每个空间相互隔离且继承登录态。

## 范例（Google Patents 关键词检索）

```js
const task = await useOrCreateTaskSpace('patent search: pcm thermal');
await openOrReuseTab('https://patents.google.com/?q=phase+change+material+thermal+management', { wait: true, timeout: 30 });
await wait(5); // 结果异步渲染
const results = await js(String.raw`(() => {
  const seen = new Set(); const out = [];
  for (const a of document.querySelectorAll('a')) {
    const m = a.href && a.href.match(/patents\.google\.com\/patent\/([^/]+)/);
    if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    if (out.length >= 10) break;
  }
  return out;
})()`);
cliLog(JSON.stringify(results));
await completeTaskSpace(task.id, { keep: false });
```

## 纪律

- 任务空间默认继承用户的 ego lite 登录态，登录后的站点无需重新输入凭据。
- 跨调用沿用同一个任务空间名即可延续会话；不用留页面给用户看时，收尾要 `completeTaskSpace(id, { keep: false })`。
- 每次打开页面用完整 heredoc 方式调用。
- 截图前先覆盖设备视口（`Emulation.setDeviceMetricsOverride`）。
- 元素定位用引用/属性，不依赖窗口坐标。
- 遇到验证码或需要人工登录：调 `handOffTaskSpace(id)` 告知用户要做什么，确认后再用 `takeOverTaskSpace(id)` 接管。
- 默认超时 90000ms（慢站点导航 + 渲染）；确实需要更久才传 `timeoutMs`，上限 300000ms。
- 连接疑似失效时重启 ego lite 应用（较新的 CLI 也提供 `ego-browser --doctor` / `--reload`）。
- 脚本保持小而可观测：导航 → 等到可见信号 → 抽取 → 报告。不要把浏览器自动化当通用爬虫。

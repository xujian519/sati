---
name: ego-browser
description: 基于 Chromium 的浏览器自动化技能（ego-browser/ego-lite），用于打开网页、填写表单、点击、截图、提取页面数据、测试 Web 应用等需要真实浏览器交互的场景；本目录记录各类任务的注意点与可复用步骤。
---

# ego-browser

浏览器自动化操作说明与学习笔记（`learnings/` 目录存放按任务分类的踩坑与可复用片段）。适用于真实浏览器场景：登录后操作、表单填写、截图、页面数据抓取、Web 应用验证等。

- 每次打开页面用完整 heredoc 方式调用。
- 截图前先覆盖设备视口（`Emulation.setDeviceMetricsOverride`）。
- 元素定位用引用/属性，不依赖窗口坐标。

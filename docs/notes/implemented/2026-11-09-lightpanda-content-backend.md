# Agent Note: Lightpanda 只作为可选的纯内容浏览器后端

Status: implemented

## Problem

内容抓取需要一个比完整浏览器更轻的后端，但现有级联（ego → browseros-neo → browser-use → playwright）承担登录态、PDF、真实截图和人机交接。把一个不支持这些能力的浏览器插进默认级联，会让登录或 PDF 任务落到错误的实现上，或者在它失败时挡住后面的后端。

## Decision

`src/browser/backend/lightpandaBackend.ts` 是可选的 `BrowserBackend`。默认候选列表不含它；`includeLightpanda` 或 `prefer: "lightpanda"` 才把它加进来，未指定 prefer 时排在 playwright 之后。

能力位：`contentCapable` 为真；`loginState`、`antiBot`、`pdf`、`trueScreenshot`、`handoff` 以及下载拦截、录屏、站点工具为假。`resolveBrowserBackend` 在 probe 之前按 `needs` 跳过不满足的后端，并打出 warn，然后继续下一个候选。探测只执行 `version`，子进程环境强制 `LIGHTPANDA_DISABLE_TELEMETRY=true`，不传 cookie 文件，不复用 ego profile。`LIGHTPANDA_SESSION_POLICY.versionPin` 为 null，探测不比较、不下载发行版。win32 直接记 missing，不启动进程。

## Alternatives considered

- **把 Lightpanda 插进默认级联、排在 playwright 之前。** 落选。内容速度不能覆盖登录、PDF 和真实截图；默认解析必须仍先命中现有四层。
- **把上游 `--dump pdf` / `--dump png` 标成 PDF 与真实截图。** 落选。这两项是文本排版导出，不是下载下来的 PDF，也不是像素截图。标成真会让专利 PDF 和留证截图选中它。
- **复用 ego 的 profile 或 cookie 文件。** 落选。Lightpanda 的 cookie jar 属于自己的 session；和 ego 混用会把登录态带进一个声明为无登录态的后端。
- **沿用 Lightpanda 默认开启的匿名遥测。** 落选。本后端启动的子进程必须默认关闭遥测，不能靠调用方记得设环境变量。
- **在这一改动里做执行层失败后的完整重试编排。** 落选。cold decision 已经会在能力不匹配或 probe 失败时继续下一个候选；中途执行失败再换后端是另一项工作，不放进这个骨架。

## Consequences

- 未显式启用时，`sati browsers` 和 `resolveBrowserBackend()` 的候选与以前相同。
- 登录、反爬、PDF、真实截图、人机交接任务即使 prefer Lightpanda，也不会选中它；内容任务在它 probe 失败时仍可落到后面的后端。
- 没有页面提取实现，也没有 Windows 原生安装路径。二进制缺失只表现为 probe `missing`。
- 现有四个后端补上 `contentCapable` / `pdf` / `trueScreenshot`：内容为真；PDF 只在已有下载拦截的 ego 与 browseros-neo 上为真；真实截图沿用已有录屏位（browser-use 为假）。

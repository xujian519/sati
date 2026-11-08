# Agent Note: Lightpanda 内容抓取走钉死的 fetch dump

Status: implemented

## Problem

可选的 Lightpanda 后端只有能力位和 `version` 探测。内容任务即使选中它，也拿不到渲染后的 Markdown 或结构化提取。未钉版本时，nightly 与稳定版的 dump 参数可能不一致，探测却仍然报 ok。

## Decision

`LIGHTPANDA_VERSION_PIN` 为 `1.0.3`。这是 lightpanda-io/browser 标签 `1.0.3` 的构建版本：发布工作流用 `-Dversion=<tag>`，`lightpanda version` 只打印该字符串。探测把 stdout 第一行与它精确比较。不匹配记 warn，不下载替换二进制，cold decision 继续下一个候选。

内容入口是 `fetchBrowserContent`。调用必须带已声明的 `needs`，且 `content` 为真。`loginState`、`antiBot`、`pdf`、`trueScreenshot`、`handoff` 任一为真则拒绝，不启动 fetch。选中 `LightpandaBackend` 时执行 `lightpanda fetch --dump markdown` 或 `--dump structured_data`，并带上 `--fail-on-http-error`、`--obey-robots`、`--terminate-ms 15000`、`--log-level error`。子进程环境仍强制 `LIGHTPANDA_DISABLE_TELEMETRY=true`。不传 `--cookie`、`--cookie-jar`、`--http-cache-dir`，不复用 ego 或其他后端的 profile。

退出码非 0、结构化结果不是 JSON 对象或数组、或进程错误，都不把 stdout 当成成功页面。此时打 warn，排除 lightpanda 后再调用 `resolveBrowserBackend`（仍带原来的 `needs`），把下一个 probe ok 的后端交还给既有级联。后面没有后端时抛出内容错误。

`resolveBrowserBackend` 与 `selectBackendForTask` 在候选能选中 lightpanda、且 `needs` 没有任何为真的键时直接抛错。

## Alternatives considered

- **不钉版本，接受任意 `version` 成功输出。** 落选。nightly 的 dump 集合会动；把未核对的二进制报成 ok 会让内容路径跑在未约定的 CLI 上。
- **版本不符时下载 1.0.3 发行版。** 落选。探测保持不安装。缺失或版本不符都继续级联。
- **用 turndown 把 `--dump html` 再转成 Markdown。** 落选。1.0.3 已在引擎内输出 markdown。再转一层会和原生 dump 分叉。
- **用 `semantic_tree` 当结构化提取。** 落选。它是无障碍树。结构化提取用 `structured_data`（JSON-LD、OpenGraph、meta）。
- **把 `--dump pdf` / `--dump png` 接到内容入口。** 落选。二者仍是文本排版导出，不是 PDF 下载或像素截图。
- **内容失败时在本函数里用 playwright 或 ego 重跑同一 URL。** 落选。那是执行期完整级联重试。这里只把下一个已探测成功的后端交回去，并保留失败原因。
- **把 ego 的 cookie 文件传给 `--cookie`。** 落选。该后端声明没有登录态。共享 cookie 会把别的后端的会话带进来。
- **默认级联把 Lightpanda 放在 playwright 之前。** 落选。未指定 prefer 时仍先命中既有四层。

## Consequences

- 只有显式启用、`needs.content` 为真、且版本恰好是 1.0.3 时，内容入口才会执行 Lightpanda fetch。
- 登录、反爬、PDF、真实截图、人机交接不能从这个入口启动 Lightpanda。
- 二进制缺失、版本不符、fetch 失败都不会停在 Lightpanda 上假装成功。没有后续后端时错误向上抛。
- 未做执行期在其他后端上重放抓取、benchmark 基线、`sati browsers` 列表和用户文档。

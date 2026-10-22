# Agent Note: 专利检索改走 JSON 主路径（解包 ego outerHTML）

Status: implemented

## Problem

`patent_search` 在真实环境恒返回 0 命中且无错误（审计 #710）。根因在 vendored
`nuo-patent@2.3.1` 的抓取链：

1. `fetchHtml` 在 ego-browser 可用时无条件走 `fetchHtmlWithEgoBrowser`，取的是
   `document.documentElement.outerHTML`；顶层 JSON 响应被 Chromium 包进 `<pre>`，
   所以 `JSON.parse` 必然失败。
2. 失败后回退 HTML 搜索页，但 Google Patents 已移除 `dd[itemprop=...]` microdata，
   `parseSearchResultsHtml` 解析 0 条，只追加“页面结构可能变化”warning。
3. 原工具把该 warning 当非致命，成功返回空 `hits`；`patentCache` 还会把这份坏结果
   按 2 小时 TTL 缓存。

vendor dist 受 checksum 审计约束不可手改，因此修复必须落在 Sati 适配层。

## Decision

在 `src/patent/data/nuo/searchProvider.ts` 增加 `withEgoJsonSearch(vendorSearch)`：

- 主路径直接请求 XHR JSON 端点：ego 可用时取 outerHTML 后用 `extractJsonText`
  解包 `<pre>` 并解码 HTML 实体；ego 不可用时用原生 `fetch` 直取 JSON。
- 解析结果带 `dataSource`：`ego-json` / `native-json` / `vendor`；`vendor` 仅作为
  主路径失败后的回退。
- 可判定语义：
  - `results` 信封完整且 `total=0` → 真实零命中（warning 明示 total=0），不缓存污染；
  - `total>0` 但解析出 0 条、信封缺失、JSON 非法 → `PARSE_ERROR`，工具层抛
    `tool_execution_failed`，不再冒充 0 命中；
  - 请求被取消 → `请求已被取消`，工具层同样报错。
- `patentCache` 对 `PARSE_ERROR` / 页面结构 warning 不写缓存；新增
  `cache.hit`/`cache.ageMs` 元数据；顺带修复只透传 `limit`、丢失
  `signal/timeout/logger` 的问题。
- 工具输出契约新增 `dataSource` 与 `cache` 字段（`outputSchema` 同步）。

真实 5 查询验收（ego 可用、limit=3）：4 条命中（含中文与 assignee 布尔式）、
1 条不存在检索式返回 total=0，全部 `dataSource=ego-json`。

## Alternatives considered

- **直接改 `vendor/nuo-patent/dist`** — 落选：dist 由 postinstall checksums 审计，
  手改会在安装/CI 被校验拒绝，且下次同步上游即丢失。
- **只把 HTML 解析 warning 升级为错误** — 落选：能暴露故障但不能恢复检索能力，
  且无法区分真实零命中（HTML 回退对 0 条与解析失败都发同一 warning）。
- **fork vendor 并改源码** — 落选：当前仓库以 workspace vendor 分发预构建产物，
  引入源码构建会扩大安装面；先落适配层，上游修复作为后续项。
- **在工具层做 JSON 抓取** — 落选：`patent_workflow_run` 的原子检索也走同一
  provider，适配层修复可同时覆盖工具与工作流两条链路。

## Consequences

- 检索主链恢复；解析故障从“静默 0 命中”变为可行动错误，缓存不再固化故障。
- 每次检索仍会 spawn 一次 ego-browser（约 1-2 秒），主路径失败时最坏多一次
  vendor 回退。
- `patent_search` 的 canonical 输出新增两个必填字段，下游若直接构造 `data`
  需同步（当前唯一消费方是 UI/LLM 文本渲染，已按附加字段兼容）。
- 上游 `nuo-patent` 仍应修复 `fetchHtml` 的 `application/json` 处理与 HTML
  microdata 解析（已提 xujian519/nuo-patent#1）；本适配层届时可退化为薄封装。

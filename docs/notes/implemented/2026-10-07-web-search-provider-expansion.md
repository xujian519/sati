# Agent Note: `web_search` provider 补齐 6 家并与设置页对齐

Status: implemented

补记：本 note 于 2026-10-10 补写——变更随 PR #610 于 2026-10-07 落地，当时未附 note。评估背景见 `docs/pilotdeck-2026-10-upstream-port-plan.md` 批次 D。

## Problem

`web_search` 只有 3 家 provider（`glm` / `tavily` / `custom`），而上游在改动前就有 `serper` / `brave`——Sati 落后两个版本。

更根本的是**枚举分散**：provider ID 与默认端点在三处各写一份，YAML 校验（`parseToolsConfig`）、工具实现（`tool/builtin/webSearch.ts`）、设置页（`agentSearch/`）分别维护，历史上已经漂移过一次（设置页可选而后端校验不认）。设置页的连通性探测（`ui/server/routes/config.js` 的 `POST /test-web-search`）另有一份自己的请求构造与响应解析——「探测通过、实际搜索解析失败」这类错配无从自动发现。

## Decision

**补齐 6 家并抽出单一事实源**：

- 新增 `src/pilot/config/webSearchProviders.ts`：`WEB_SEARCH_PROVIDERS`（9 个 ID，含 `custom`）、`SERPAPI_ENGINES`、`WEB_SEARCH_ENDPOINTS`、`WEB_SEARCH_DOCS` + 两个 type guard。YAML 校验、工具、`ui/server` 路由、设置页共用这一份。`parseToolsConfig` 的硬编码三值校验改为 `isWebSearchProvider()`，unknown-field 白名单加 `searchEngine`。
- 新增 `src/pilot/config/webSearchAdapter.ts`：`additionalSearchRequest`（六家的请求构造——serpapi 走 GET query + `engine`；brave 走 GET + `X-Subscription-Token`；serper 走 POST + `X-API-KEY`；baidu/bocha 走 POST + `Authorization: Bearer`；exa 走 POST + `x-api-key`）、`additionalSearchResults`（六种响应形态归一化：baidu `references`、bocha `data.webPages.value`、exa `results`、serper `organic`、brave `web.results`、serpapi `organic_results`）、`redactSearchError`（走 query 认证的 API 会把密钥放进 URL，错误信息必须抹掉明文 / URL 编码 / query 三种形态）。
- 新增 `src/tool/builtin/webSearchPerformers.ts`：把 glm / tavily / custom / additional 四个 performer 与共享 helper（截断、abort 转发、超时判别）集中；`webSearch.ts` 从 722 行降到 322 行，只留工具定义、可用性判定与 API key 环境变量表（新增 6 组 env 探测）。
- 装配点：`tools.webSearch.searchEngine` 经 `src/cli/projectRuntimeFactory.ts` 透传给工具；设置页 provider 列表与端点表同步（`ToolsSection.tsx` / `webSearchConfig.ts` / 两个 locale 的 `settings.json`）。
- **provider 配置项与工具入参分离**：`searchEngine` 是「这个 provider 怎么配」，不进 `web_search` 的 `inputSchema`——入参仍是 `query` + `gl`，因此不改变请求内容哈希，既有 llm-replay fixture 无需重录。

空结果语义按家分别对待（这是各家 API 的真实差异，不是宽松）：serpapi 无自然结果时合法地省略 `organic_results`（以 `search_metadata.status === "Success"` 认定空列表）；brave 同理会省略整个 `web` 块；serper 稳定给出 `organic: []`，因此**缺失即视为异常响应**。

## Alternatives considered

- **只补 `serper` / `brave` 两家（即时对齐到上游改动前）** — 落选：设置页与后端校验本就需要同一份枚举，多补 4 家的边际成本远低于再走一轮评估；用户已选「对齐上游」。
- **把 `searchEngine` 加进 `web_search` 的 `inputSchema`** — 落选：上游没加（属自创），且入参变化会让请求内容哈希变化、触发全部 llm-replay fixture 重录；搜索用哪个底层引擎是配置而非单次调用语义。
- **把 adapter 留在 `src/tool/builtin/`** — 落选：`ui/server` 的连通性探测需要同一份请求构造与归一化，放在 `tool/builtin` 会让 `ui/server` 越界导入工具实现；`src/pilot/config/` 已是配置族。
- **让 `ui/server` 各写一份请求/响应处理** — 落选：正是「探测通过但实际搜索解析失败」这种错配的来源；`config.js` 的注释即写明复用工具侧归一化。
- **只加新 provider、不动既有三个 performer** — 落选：会留下两套共享 helper（截断 / abort / 超时），且 `webSearch.ts` 已 722 行、逼近 800 行的 file-size 棘轮。
- **统一用 `gl` 之外再暴露 `engine` 之类的入参** — 落选：入参每加一个都要付 fixture 重录与工具描述维护成本，收益只覆盖 1 家 provider。

## Consequences

- 用户可配 9 家搜索 provider；端点与文档入口从一处取，设置页、YAML 校验、工具实现不再各自漂移。
- 设置页的连通性探测与真实搜索共用请求构造与响应归一化，「探测通过但搜索报错」这类错配不再可能。
- 走 query 认证的 provider（serpapi）在错误信息里不会泄露 API key。
- 代价：`src/pilot/` 与 `src/tool/builtin/` 各多两个 / 一个文件；`web_search` 的可用性判定仍按 provider 逐个探测 env（新增 6 组）——provider 越多，`checkAvailability` 的分支越长。
- 已知缺口：provider 的 API 差异（限流、付费档、返回字段）只按文档实现，没有真实密钥的端到端探测记录；新增 provider 时需人工核对端点与响应形状。

# Agent Note: 上传限额单一事实源与探测端点限流

Status: implemented

补记：本 note 于 2026-10-10 补写——变更随 PR #610 于 2026-10-07 落地，当时未附 note。评估背景见 `docs/pilotdeck-2026-10-upstream-port-plan.md` 批次 E。

## Problem

两个都在「对外发真实请求 / 对外限制」的面，此前都不在配置面上：

1. **上传限额散落**：50MB 与 20 个文件硬编码在 `ui/server/services/uploads.js` 的三处（multer `limits`、`array()` 的文件数参数、错误文案）。改一处漏一处会让「报错说 50MB、实际拦在别处」这类不一致无从发现；前端也只能靠猜，桌面端与 Web 端无法分别调参。
2. **连接性探测无限流**：`POST /api/config/test-connection` 每次都会向上游发真实模型请求（出网 + 按量计费），却没有任何速率限制——可被反复触发刷出网与计费。设置页的 `POST /test-web-search` 同理。

## Decision

- 新增 `ui/server/services/uploadLimits.js`：`UPLOAD_LIMITS`（`maxFileBytes` / `maxFileCount`）+ 由它派生的 `UPLOAD_LIMIT_MESSAGES`（文案里的数字不再是手写的）+ `publicUploadLimits()` 的对外形状。`uploads.js` 的 multer `limits`、`array()` 计数与两条错误分支都改读这里。
- 新增 `GET /api/upload/limits`（`ui/server/routes/project-uploads.js`，走 `authenticateToken`），对外暴露该形状，供前端在选文件前给出提示。
- `ui/server/services/rate-limit.js` 复用既有的 `createRouteRateLimiter` 工厂新增两个实例：`connectionTestRateLimiter` 与 `webSearchTestRateLimiter`，各 **10 次/分钟**（按用户 id 或 IP 分桶，超出返回 429 + `Retry-After` + `code: "RATE_LIMITED"`），分别挂在两条探测端点前。10 次/分钟 ≈ 逐个试模型的正常节奏。
- 回归判据：`ui/server/routes/config.test.js` 的「rate-limits connection probes so a paid upstream cannot be hammered」连打 11 次，断言前 10 次无 `RATE_LIMITED`、第 11 次被拦（测试文件的 `afterEach` 会 `vi.resetModules()`，限流桶不跨用例残留）。

## Alternatives considered

- **把限额做成构建期常量（env / 打包参数）** — 落选：桌面端与 Web 端要分别调参的需求还在路上，env 会让「运行时到底拦在多少」再次取决于部署方式；单一模块 + 对外查询接口是当下最小可验证的形态。
- **只集中常量，不暴露接口** — 落选：前端拿不到限额就只能继续猜（或硬编码同一份数字，等于第二个事实源）。
- **为探测端点新写一个限流器** — 落选：`ui/server` 已有 `createRouteRateLimiter`（Office 预览两条端点在用），复用工厂比新增一套实现更少分叉。
- **用 `src/shared/ttl-cache.ts` 自建桶** — 落选：那是 `src/` 侧工具，`ui/server` 用它会多一层跨树依赖，且现有工厂已带 `Retry-After` 与统一 429 形状。
- **把限流阈值做成配置项** — 落选：本批的目标是「挡住无限刷」，不是「可调风控」；阈值调参需求出现前不引入第四处配置面。

## Consequences

- 上传限额只有一处可改；错误文案与 multer 实际拦截值必然一致。
- 探测端点不再能被无限刷（按用户/IP 桶，10 次/分钟）。
- 代价：`GET /api/upload/limits` 目前**没有客户端消费**——本批只做到「限额可查、可单点调参」，前端尚未接线给出「选文件前提示」；上传限额本身也**没有测试**（探测限流有），`uploads.js` 重新硬编码数值不会触发任何判据。
- 已知缺口（承接上一条）：接口稳定后由前端接线补消费与测试。

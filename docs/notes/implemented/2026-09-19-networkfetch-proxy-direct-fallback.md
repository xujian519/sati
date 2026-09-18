# Agent Note: networkFetch 在代理连不上时回退直连

Status: implemented

## Problem

`src/network/fetch.ts` 走的是**裸 undici**（`await import("undici")` 后直接 `undiciFetch`），而不是被 `src/cli/proxy.ts` 包装过的 `globalThis.fetch`。这个选择本身是有意的——`performFetch` 的注释写明：per-request dispatcher 会绕过 `proxy.url` / `proxy.noProxy` 的热重载，所以代理必须由全局 dispatcher 承担。

代价是 `installFetchProxyFallback` 那条"代理连不上就直连重试一次"只对走全局 `fetch` 的调用方有效（各 IM 渠道适配器）。经 `networkFetch` 出网的主链路全都拿不到它：

- 模型流式请求（`src/model/streaming/streamModel.ts`）
- `web_search`（`src/tool/builtin/webSearch.ts`）
- `url_fetcher`（`src/tool/builtin/web/urlFetcher.ts`）
- 学术文献连接器（`src/literature/runtime/http.ts`）、MCP 传输（`src/mcp/client/transport.ts`）、专利 PDF 兜底下载

后果是代理配置存在但代理进程没跑（或端口写错）时，模型请求与联网工具**直接硬失败**，而 `CHANGELOG.md` 声称的"代理不可达时回退直连（双端）"对这些路径不成立。

## Decision

**给网络层留一个"谁在管代理"的注册缝，代理层注册，`networkFetch` 消费。**（issue #448 第 ③ 项）

- 新增 `src/network/proxyFallback.ts`：`ProxyConnectionFallback = { isProxyActive, isProxyConnectionError, directDispatcher }` 的注册点，以及纯函数 `withDirectProxyFallback(attempt, current?)`——先执行 `attempt()`，失败且"当前走代理 + 该错误是代理连不上"时，取直连 dispatcher 再执行一次 `attempt(dispatcher)`。
- `src/cli/proxy.ts` 在 `installGlobalProxy` 开头注册（`isProxyActive` 读活的 `dispatcherState`，`isProxyConnectionError` 复用既有实现，`directDispatcher` 是新导出的 `getDirectDispatcher()`），并让原有的全局 `fetch` 回退改用它，两处共用同一个缓存 Agent。
- `src/network/fetch.ts` 的 undici 分支改为 `withDirectProxyFallback(dispatcher => undiciFetch(...))`；注入 `fetchImpl` 的测试缝**不**参与（回退只针对真实 undici 路径）。

三条边界是刻意定的：

1. **只在连接建立阶段失败时回退**（复用 `isProxyConnectionError`：`ECONNREFUSED` / `UND_ERR_CONNECT_TIMEOUT`）。HTTP 状态码错误、TLS 错误、超时都与"代理是否可达"无关，不触发。
2. **直连也失败时抛原始错误**，不抛直连的次级错误——根因在代理侧，不该被掩盖。
3. **未注册即行为不变**：没有经过 `installGlobalProxy` 的进程（多数单测、库式调用）拿不到回退，不会凭空多一次请求。

回退复用**同一次尝试的 AbortSignal**，因此不额外引入超时预算：调用方给的 `timeoutMs`（模型路径上来自 `provider.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS`）同时兜住两次尝试的总时长，不会把"快速失败"变成"长挂"。

验证（`tests/network/proxyFallback.spec.ts`，7 个用例）：

| 用例 | 断言 |
|---|---|
| 代理不可达 | 第二次尝试带上直连 dispatcher，返回成功 |
| 未处于代理态 | 不重试，抛原始错误 |
| 与代理无关的失败 | 不重试，抛原始错误 |
| 直连也失败 | 抛**原始**代理错误（非直连错误） |
| 未注册回退 | 不重试，抛原始错误 |
| 注入 `fetchImpl` | 完全不触碰回退缝 |
| 端到端（本地服务） | 全局 dispatcher 固定指向不可达代理 + 回环目标 → 回退直连打到本地 HTTP 服务，200 `local-ok` |

负控制：把"是否重试"的判据改成恒真后，第 1、4 个用例与端到端用例全部转红；恢复后 7/7 通过。端到端用例不依赖外网（回环 + 不可达代理），可长期留在 CI。

## Alternatives considered

- **让 `src/network/fetch.ts` 直接 import `src/cli/proxy.ts`** — 落选：那是网络层（下）反向依赖 cli 层（上），本仓库此前没有任何 `src/network` → `src/cli` 的边。用注册缝把方向反过来（cli → network），网络层不必知道代理怎么装配。
- **让 `networkFetch` 改走 `globalThis.fetch`** — 落选：那正是 `performFetch` 注释明确禁止的（会绕过 `proxy.url` / `proxy.noProxy` 的热重载；且全局 fetch 已被包装，会二次包装）。为了拿到回退而放弃热重载，取舍不划算。
- **把 `isProxyConnectionError` 复制/移进网络层** — 落选：错误形态知识（`ECONNREFUSED` / `UND_ERR_CONNECT_TIMEOUT` 走 cause 链）属于代理层，复制一份就是第二个会漂移的口径（正是本议题登记的病根）。改由注册对象带回。
- **不做代理态判断，任何 `ECONNREFUSED` 都直连重试一次** — 落选：目标本身拒绝连接（本地服务没起、端口写错）会给每次请求白送一次重复连接尝试。判断代理态的成本只是一个布尔读。
- **给直连重试配独立的更短超时** — 落选：回退已经共享外层尝试的 signal，总时长被调用方 `timeoutMs` 兜住；再加一层计时器等于把同一件事算两遍，还会让"谁超时的"变难判断。
- **顺带把 nuo-patent（issue #448 第 ② 项）也接上全局 dispatcher** — 落选（本轮不可行）：`vendor/nuo-patent` 是 checksum 审计过的预构建产物（`SOURCE_COMMIT: github:xujian519/nuo-patent#v2.3.1`，postinstall 跑 `verify-checksums.mjs`，改 dist 会导致 `pnpm install` 失败）。正确做法是在上游改并重新 vendor，属于另一个仓库的变更。

## Consequences

- 代理进程没跑 / 端口配错时，模型流式请求、`web_search`、`url_fetcher`、文献检索、MCP 传输不再硬失败，而是回退直连——`CHANGELOG.md` 那条"代理不可达时回退直连（双端）"对主链路终于成立。
- 代价一：代理不可达时每次请求多一次连接尝试（连接建立阶段失败，通常毫秒级；直连若被黑洞丢包则持续到调用方 `timeoutMs`，总时长仍与不配置代理时同量级）。
- 代价二：目标自身拒绝连接的错误路径上，多一次注定失败的连接尝试。
- 未验证：**能成功直连的场景**在本机无法用真实外网演示——这台机器的直连出口本身不通（`curl --noproxy` 对 google patents / api.ipify.org 都超时，Chromium 的 `--no-proxy-server` 也压不过隧道）。因此端到端验证退回到本地回环服务 + 不可达代理的组合（上表最后一行），它证明的是"回退真的发生且能打通直连目标"，不是"本机能直连公网"。
- 未处理：本仓库仍有两份全局代理实现（`src/cli/proxy.ts` 与 `ui/server/utils/proxy.js`）手工同步、取值链不认 `ALL_PROXY`（issue #448 第 ④⑤ 项）。

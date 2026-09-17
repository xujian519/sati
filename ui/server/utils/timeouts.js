/**
 * `ui/server` 的超时/延迟取值注册表（集中定义，#354 超时半）。
 *
 * **这是一张注册表**：本目录下 `setTimeout`/`setInterval` 的第二个实参都从这里取，因此**改值前先想清
 * 有没有用户可见影响**——超时值是**行为面**，不是实现细节：
 * - 调小：一个正常但慢的上游会被误判成失败（设置页弹"连接超时"、插件被当成启动失败而 kill）。
 * - 调大：设置页"测试连接"卡着不返回、插件进程迟迟不收、重启迟迟不生效。
 * 要改某个值，请单独开 PR 说明动机与用户可见影响，不要"顺手"改。
 *
 * **为什么集中**：这 9 处此前是散落在 4 个路由 + 2 个服务里的内联毫秒字面量，同一个数（如 10_000）
 * 出现两次却等的是完全不同的上游，调一个超时要跨 6 个文件比对。集中后一处总览，且**名字即说明"在等什么"**。
 *
 * **为什么只集中、不改数值**：下表的值逐字照抄各调用点此前的内联字面量（含 `10_000` 的写法），
 * 一个数都没动——超时数值属行为契约，改值不是重构而是行为变更。
 *
 * **值相同 ≠ 语义相同，故不强行合并**：合并会把"调一处超时"变成"顺带影响另一个子系统"。
 * 例如本表的飞书 token 探测与 provider 模型列表探测都是 10s，但一个等的是飞书开放平台、
 * 一个等的是用户自填的 LLM provider（可能是本地 Ollama，也可能是慢的海外端点），因此**各留各的名字**。
 *
 * **故意不在本表**（问题域不同，或已是具名量、不在本次清单内，均未改动）：
 * - `ui/server/routes/gateway.js` 的 `WECOM_QR_TIMEOUT_MS`（300_000，企业微信二维码轮询）：
 *   已是具名常量，且不通过 `setTimeout` 延时表达。
 * - `ui/server/routes/config.js` 的 `/test-connection`（`const timeout = 10_000`）与联网搜索测试
 *   （`const timeout = 15_000`）：已是局部具名变量，本次未纳入。
 * - 插件启动超时/强杀宽限在源码里各有一句写死秒数的说明注释（"within 10 seconds"、"after 5 seconds"），
 *   本次按"只改延时表达式"未动那些注释，改值时记得同步。
 * - `ui/server` 里**本来就是具名常量**的超时仍留在各自模块（不在本次清单，一律未改动）：
 *   `websocket/shell.js` 的 `PTY_SESSION_TIMEOUT`、`utils/plugin-loader.js` 的 `BUILD_TIMEOUT_MS` 与局部
 *   `RETRY_DELAY_MS`、`team-presence.js` 的 `HEARTBEAT_INTERVAL_MS`、`services/memoryService.js` 的
 *   `MEMORY_SCHEDULER_INTERVAL_MS`、`services/projects-watcher.js` 的 `WATCHER_DEBOUNCE_MS`、
 *   `sati-bridge.js` 的 `GATEWAY_CONNECT_RETRY_INTERVAL_MS`；另有一批超时由调用方传参
 *   （如 `services/desktopUpdateService.js` 的 `timeoutMs`）。
 *   ⇒ 本表**不是** `ui/server` 超时的全集，只是"原本写死内联字面量"那 9 处的收敛点。
 */
export const SERVER_TIMEOUTS = {
  // ── 更新流程（ui/server/routes/update.js）─────────────────────────────────────
  /** `/api/update/restart` 先回响应，再等这么久才 spawn 替身进程并退出——留给响应刷出与前端切"重启中"。 */
  UPDATE_RESTART_DELAY_MS: 1000,
  /** 替身进程已 spawn、进程退出前再等这么久，让已写出的响应真正落到 socket 上。 */
  UPDATE_EXIT_FLUSH_DELAY_MS: 500,

  // ── 配置文件监听（ui/server/services/satiConfigWatcher.js）───────────────────
  /** UI 自己写盘后抑制 watcher 事件的窗口：避免同一次保存触发第二次 reload（写盘前 suppress 计数 +1）。 */
  CONFIG_WATCH_SUPPRESS_WINDOW_MS: 1500,
  /** 配置文件变更防抖：编辑器保存常触发多个事件，静默这么久没有新事件才 reload。 */
  CONFIG_WATCH_DEBOUNCE_MS: 250,

  // ── 插件子进程（ui/server/utils/plugin-process-manager.js）──────────────────
  /** 插件 server 启动后等它打印 `{ ready: true, port }` 的最长预算；到点即 kill 子进程并上报启动失败。 */
  PLUGIN_START_READY_TIMEOUT_MS: 10000,
  /** 插件 SIGTERM 后仍不退出的宽限：到点升级 SIGKILL，保证 `stopPluginServer` 不会永远挂着。 */
  PLUGIN_KILL_GRACE_MS: 5000,

  // ── 外部会话 API（ui/server/routes/agent.js）────────────────────────────────
  /** `POST /api/agent` 响应（或 SSE 流）结束后，删除克隆目录/会话记录前的延迟。 */
  EXTERNAL_SESSION_CLEANUP_DELAY_MS: 5000,

  // ── 设置页上游探测（ui/server/routes/config.js、gateway.js）─────────────────
  /** provider 模型列表探测（`POST /api/config/models`）的上游请求超时，到点 abort。 */
  PROVIDER_MODEL_LIST_PROBE_TIMEOUT_MS: 10_000,
  /** 飞书/飞书国际版凭据校验（`POST /api/gateway/feishu/test`）换 tenant_access_token 的上游超时，到点 abort。 */
  FEISHU_TOKEN_TIMEOUT_MS: 10_000,
};

/**
 * `src/` 的超时/延时取值注册表（集中定义，#354 超时半；端口半见
 * `src/adapters/channel/protocol/channel-defaults.ts`）。
 *
 * **这是一张注册表，不是一堆魔法数字的别名**：改值前先想清有没有用户可见影响——超时值是**行为面**，
 * 不是实现细节：
 * - 调小：一个正常但慢的对端会被误判成失败（网关握手被判超时、渠道鉴权被判拒绝、子进程被提前 SIGKILL）。
 * - 调大：断线后迟迟不重连、强杀迟迟不生效、用户已看到回复但服务还没重启。
 * 故**改值属行为变更**（单独开 PR 说明动机与用户可见影响，并在 `docs/notes/` 留决策记录），不是重构。
 *
 * **为什么集中**：这 19 处此前是散落在 13 个文件里的内联毫秒字面量，同一个数（如 `5000`）在四个文件里
 * 等的是完全不同的东西（HA 重连、QQ 重连、WhatsApp 强杀宽限……），要调一个超时得跨文件反查它到底是
 * "什么"超时。集中后一处总览，且**名字即说明"在等什么"**。
 *
 * **为什么只集中、不改数值**：下列取值逐字照抄各调用点此前的内联字面量（连同 `20_000` 的写法），一个数
 * 都没动；取值守恒由 `timeout-audit`（比对基线版与工作区每处延时的取值多重集）逐文件证明。
 *
 * **值相同 ≠ 语义相同，故不强行合并**：合并会把"调一处超时"变成"顺带影响另一个子系统"。最典型的是
 * 三处"等多久才强杀"（`SHELL_*` / `EXECUTE_CODE_*` / `WHATSAPP_BRIDGE_*`）：操作同形，但对端进程不同、
 * 宽限取值本来就有差异（3s / 500ms / 5s），合并必然改值，故各留各的名字。
 *
 * 命名与类型约定：
 * - 名字说「在等什么」，不说「等多久」：`HA_WS_AUTH_TIMEOUT_MS`，不要 `TIMEOUT_20000` / `DELAY_500`。
 * - 单位一律毫秒；`0` 不是「没有等待」，而是「让出到下一个宏任务」，见 `NEXT_TASK_MS`。
 * - 形式统一为 `export const NAME = <数字>`：`const` 的推断类型是**加宽字面量类型**，可直接传给
 *   `setTimeout`/`setInterval` 的 `number` 形参，无需断言（`as const` 反而是多余的手续）。
 * - 形态上用**扁平具名导出**而非 `UI_TIMEOUTS` / `SERVER_TIMEOUTS` / `CHANNEL_DEFAULT_PORTS` 那样的
 *   单对象表：src 侧调用点大多在深嵌套闭包里，扁平名字更自解释
 *   （`setTimeout(fn, WHATSAPP_BRIDGE_READY_POLL_MS)` 优于 `setTimeout(fn, TIMEOUTS.whatsappReadyPoll)`）。
 *
 * **故意不在本表**（不在本次清单内，或已是具名量，均未改动）：
 * - 已是具名常量的：`WhatsAppChannel` 的 `POLL_MS` / `READY_TIMEOUT_MS`、`CronStoreMigration` 的
 *   `LOCK_STALE_MS`、`commandRunner` 与 `executeCode` 的 `ABORT_FORCE_RESOLVE_MS`。
 * - 不以 `setTimeout` 第二实参表达的等待：`AbortSignal.timeout(...)`（WhatsApp 探活/send 等）、
 *   `execFile` 的 `timeout`（`ChannelCommandRegistry` 的更新脚本预算）、`classifyAndRoute` 里
 *   `Math.max(500, config.judgeTimeoutMs ?? 5000)` 这类**来自配置**的请求超时。
 * - 由对端协议给定的：`qqbot-gateway` 的心跳周期（网关下发的 `heartbeat_interval`，缺省 41250）与
 *   access token 的预刷新提前量（按 `expires_in` 推导），改它们要动协议适配逻辑而非一张表。
 */

// ── 渠道长连接：握手与重连 ───────────────────────────────────────────────────────────────
// 渠道相关取值：与端口/协议对端的握手窗口或心跳节奏绑定，单方面改值会让适配器与对端行为失配。

/** Home Assistant WebSocket 鉴权回执的等待上限：到点仍未收到鉴定结果即判鉴权失败并清理连接，不无限挂着。 */
export const HA_WS_AUTH_TIMEOUT_MS = 20_000;

/** Home Assistant WebSocket 掉线（close）后重开连接前的等待：给对端一点回收旧会话的时间，避免立刻重连被拒。 */
export const HA_WS_RECONNECT_DELAY_MS = 5_000;

/** QQ 机器人网关收到 op 9（Invalid Session）后重发 identify 前的等待：会话已被对端置无效，立即重发只会再被判无效。 */
export const QQBOT_REIDENTIFY_DELAY_MS = 2_000;

/** QQ 机器人网关断线后重连前的等待：触发点是连接断开，区别于上面 op 9 会话失效的重新鉴权等待，故各留一名。 */
export const QQBOT_RECONNECT_DELAY_MS = 5_000;

// ── 渠道轮询与接收循环 ───────────────────────────────────────────────────────────────────

/** WhatsApp bridge HTTP 就绪探活的重试间隔：bridge 进程仍在启动，探活失败即按此间隔重试，直到 `READY_TIMEOUT_MS` 用尽。 */
export const WHATSAPP_BRIDGE_READY_POLL_MS = 400;

/** Signal 接收循环的失败退避：HTTP 非 2xx、无响应体或流结束时按此等待后再连（等待可被 abort 打断，不拖延 stop）。 */
export const SIGNAL_RECEIVE_RETRY_BACKOFF_MS = 3_000;

// ── Gateway 客户端握手 ───────────────────────────────────────────────────────────────────

/** Gateway hello 握手的等待上限：冷启动（Docker 下 gateway 要先初始化 MCP/cron/渠道）可能十几秒才回 hello，此值由 5s 上调为 10s（#104）；下调会把慢启动误判成握手失败。 */
export const GATEWAY_HELLO_TIMEOUT_MS = 10_000;

/** hello 帧尚未到达时的轮询间隔：原为内联 `0`（紧凑自旋），同一次修复（#104）上调为 50ms 让出给入站帧。 */
export const GATEWAY_HELLO_POLL_INTERVAL_MS = 50;

// ── 子进程收尾：SIGTERM→SIGKILL 升级宽限 ─────────────────────────────────────────────────

/** bash 工具终止进程组后的强杀宽限：SIGTERM 送达进程组后等这么久仍不退，才升级 SIGKILL（正常收尾不该被立刻砍断）。 */
export const SHELL_KILL_ESCALATION_GRACE_MS = 3_000;

/** execute_code 沙箱子进程的同形强杀宽限（POSIX 进程组与非 POSIX 单进程两条分支共用同一取值）；取值短于 bash 的 3s，故不与其合并。 */
export const EXECUTE_CODE_KILL_ESCALATION_GRACE_MS = 500;

/** WhatsApp bridge 子进程的同形强杀宽限：清理 bridge 时先 SIGTERM，等这么久不退再 SIGKILL；取值与上面两处都不同，独立成值。 */
export const WHATSAPP_BRIDGE_KILL_ESCALATION_GRACE_MS = 5_000;

/** Windows 上 `exit` 已到而 `close` 未到时的兜底收尾等待：等 stdio 真正关闭，超时则按 exit 码收尾（仅 win32 走这条）。 */
export const WINDOWS_CLOSE_FALLBACK_MS = 250;

// ── 启动让位（0 ms，无时长语义）─────────────────────────────────────────────────────────

/**
 * 让出到**下一个宏任务**：`0` 不是「没有等待」，而是把回调推迟到当前这一轮同步装配（含 server listen）
 * 之后执行，让不该阻塞启动的工作"先落地再跑"。
 * - `src/cli/projectRuntimeFactory.ts`：判例向量的分批预热（该处注释已写明"setTimeout 0 即安全"）；
 * - `src/knowledge/assemble.ts`：embedding 一致性自检（首个 await 之前有采样 SQL，直接调用实测阻塞启动约 7s）。
 * 改成正数会把这段工作重新推回启动路径；换 `setImmediate`/`queueMicrotask` 则改变"谁先跑"的次序——同属行为变更。
 */
export const NEXT_TASK_MS = 0;

// ── 定时节奏：交互刷新与后台任务 ─────────────────────────────────────────────────────────

/** TUI 活动行 spinner 与耗时的刷新间隔：纯展示节奏，不参与任何超时判定（调大只是动画变卡）。 */
export const TUI_SPINNER_TICK_MS = 100;

/** IM 渠道 `/update` 执行完到触发宿主重启之间的延迟：留出时间把"服务即将重启"的回复送达用户，避免回复被重启吞掉。 */
export const UPDATE_RESTART_REPLY_DELAY_MS = 2_000;

/** cron store 迁移抢锁失败后的重试间隔（最多尝试 100 次；陈旧锁另由 `LOCK_STALE_MS` 判定后强夺）。 */
export const CRON_MIGRATION_LOCK_RETRY_MS = 100;

/** token saver judge 请求重试前的退避：第 2、3 次尝试前各等这么久（最多 3 次；单次请求本身的超时另由 `judgeTimeoutMs` 控制）。 */
export const JUDGE_RETRY_BACKOFF_MS = 1_000;

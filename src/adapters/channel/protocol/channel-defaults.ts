/**
 * 渠道端口默认值（集中定义，#354）。
 *
 * **为什么集中**：这五个端口此前各自写在各适配器里（每个文件一份 `const DEFAULT_PORT = <n>`），
 * 改端口、排查"端口被占用"、写部署文档都要跨 4–5 个文件比对；集中后一处总览，且能被测试固定住。
 *
 * **为什么只集中、不改数值**：端口默认值可能已被用户配置、部署脚本或反向代理固化，改默认值属
 * **行为变更**而非重构。本表的值就是各渠道此前的默认值，逐字未动（`channel-defaults.spec.ts` 固定住）。
 *
 * **覆盖优先级**（各渠道既有语义，未改）：显式 `options.port` → 该渠道的专用环境变量 → 本表默认值。
 * 注意 `wecom-callback` 对 `port <= 0` 有"回落默认值"的兜底语义（见其构造函数），
 * `tests/adapters/wecom-callback-contract.spec.ts` 依赖这一语义（用探测端口而非 0）。
 *
 * 不在此表的端口：`src/cli/commands/patentSearch.ts` 的 `DEFAULT_PG_PORT`（5433）——那是
 * **Postgres 服务端口**，不是渠道监听端口，与"渠道端口冲突要跨文件排查"不是同一个问题域，
 * 故留在原处（已是具名常量），仅更名以区别于渠道端口。
 */
export const CHANNEL_DEFAULT_PORTS = {
  /** API Server 渠道（可用环境变量 `API_SERVER_PORT` 覆盖）。 */
  apiServer: 8642,
  /** Webhook 渠道（仅显式 `options.port` 可覆盖，无专用环境变量）。 */
  webhook: 8643,
  /** 企业微信回调渠道 `wecom-callback`（可用环境变量 `WECOM_CB_PORT` 覆盖）。 */
  wecomCallback: 8780,
  /** 短信（Twilio）渠道（可用环境变量 `TWILIO_WEBHOOK_PORT` 覆盖）。 */
  sms: 8790,
} as const;

/** 渠道默认端口表的取值类型（`8642 | 8643 | 8780 | 8790`）。 */
export type ChannelDefaultPort = (typeof CHANNEL_DEFAULT_PORTS)[keyof typeof CHANNEL_DEFAULT_PORTS];

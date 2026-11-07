/**
 * 网关会话标识（wire 层唯一名，见 #812）。
 *
 * 边界：协议/网关/远程客户端一律 `sessionKey`；进入 agent/session/transcript
 * 层后同名值叫 `sessionId`。两者目前是同一字符串（1:1），但不得在同一层混用
 * 两个名字——跨层时显式改名，避免把 wire 字段误传进磁盘/转录层。
 */
export type GatewaySessionKey = string;

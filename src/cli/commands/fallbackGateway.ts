/**
 * 本地 gateway 不可用时的降级 `Gateway` 实现（P2.7 从 `cli/sati.ts` 原样搬出，逐 token 未改）。
 *
 * 用途：`sati tui` 内嵌 gateway 启动失败时回退直连、`sati`（无子命令）交互 CLI 的兜底。
 * 除 `submitTurn` 返回一条 `local_gateway_unavailable` 错误流外，其余方法要么是空实现、
 * 要么显式抛「未配置」——降级不静默（调用方拿得到失败原因）。
 */

import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../gateway/index.js";

export function createFallbackGateway(sanitizeSessionIdForPath: (sessionId: string) => string): Gateway {
  async function* errorStream(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    yield {
      type: "error",
      code: "local_gateway_unavailable",
      message: `No Sati server is available and local config could not start session ${input.sessionKey}.`,
      recoverable: false,
    };
  }
  return {
    submitTurn: errorStream,
    abortTurn: async () => undefined,
    listSessions: async () => ({ sessions: [] }),
    resumeSession: async input => input,
    newSession: async input => ({
      // 与磁盘 transcript 文件名一致（sanitize 幂等），避免会话列表
      // sessionId（磁盘文件名）与 gateway sessionKey 双编码失配。
      sessionKey: sanitizeSessionIdForPath(`${input.channelKey}:project=${input.projectKey ?? process.cwd()}:s_local`),
    }),
    closeSession: async () => undefined,
    describeServer: async () => ({ mode: "in_process" }),
    cronCreate: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronUpdate: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronList: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronDelete: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronStop: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronRunNow: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    respondElicitation: async () => ({ delivered: false }),
    permissionDecide: async () => ({ delivered: false }),
    grantSessionPermission: async () => ({ granted: false }),
    readSessionMessages: async () => {
      throw new Error("read_session_messages is not configured.");
    },
    readSubagentMessages: async () => {
      throw new Error("read_subagent_messages is not configured.");
    },
    forkSession: async () => {
      throw new Error("fork_session is not configured.");
    },
    listProjects: async () => ({ projects: [] }),
    describeProject: async input => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  };
}

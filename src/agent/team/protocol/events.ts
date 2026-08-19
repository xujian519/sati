/**
 * TeamEvent 事件族（M2）：团队编排层的对外事件契约。
 * 广播通道：经 gateway 复用现有事件帧（GatewayEvent team_event 变体）按队长会话扇出，
 * 协议不升版（无新增方法）；Web 客户端未知帧走 default 忽略（M4 再消费）。
 * 全部事件入事件矩阵（pnpm gen:event-matrix 重新生成 + check:event-matrix 门禁）。
 */
import type { TeamTaskStatus } from "../taskpool/task-status.js";

export type TeamEvent =
  | { type: "team_created"; teamId: string; name: string; captainSessionKey: string }
  | { type: "member_added"; teamId: string; memberId: string; roleSlug: string }
  | { type: "member_removed"; teamId: string; memberId: string; reason: string }
  | { type: "member_status"; teamId: string; memberId: string; status: "idle" | "working" }
  | { type: "member_idle"; teamId: string; memberId: string }
  | { type: "task_created"; teamId: string; taskId: string; subject: string; dependencies: string[] }
  | { type: "task_claimed"; teamId: string; taskId: string; memberId: string; attempt: number; attemptId: string }
  | { type: "task_updated"; teamId: string; taskId: string; status: TeamTaskStatus; attemptId?: string }
  | { type: "task_completed"; teamId: string; taskId: string; memberId: string; attempt: number; output?: string }
  | { type: "task_failed"; teamId: string; taskId: string; memberId: string; attempt: number; reason?: string }
  | { type: "task_reassigned"; teamId: string; taskId: string; fromMemberId: string; toMemberId: string }
  | {
      type: "message_delivered";
      teamId: string;
      recipient: string;
      /** 批次首条发送者（= senders[0]，兼容既有消费方）。 */
      sender: string;
      /** M3：批次完整发送者列表（additive——协议不升版，Web 客户端未知字段忽略）。 */
      senders: string[];
    }
  | { type: "team_archived"; teamId: string };

/**
 * 广播出口：按队长会话扇出（注入 InProcessGateway.emitForSession 闭包）。
 * 返回 true = 事件已排队投递（有接收方）；false = 无接收方（事件丢失），
 * 关键路径（如审批转发）据此决定是否落盘补偿。
 */
export type TeamEventEmitter = (captainSessionKey: string, event: TeamEvent) => boolean;

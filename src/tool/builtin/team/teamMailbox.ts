/**
 * 成员邮箱工具（M3）：team_send_message——队长或成员投递持久消息（复用 mailbox 租约写入），
 * 锁外 kickMember(recipient) 触发既有「邮箱优先」投递路径（unreadMessages → claimDelivery → wake → ack）。
 * 作业面（domain: "team"）。注意：captain 离线时调度器暂停投递（消息留邮箱，队长回来再投）——
 * 与 isCaptainOnline 统一语义。
 *
 * 事件语义唯一化（quality review 定型）：message_delivered 由调度器 ack 路径发出
 * （scheduler.ts kickMember 邮箱投递成功分支，批次粒度），本工具只落库 + kickMember，
 * 不 emit——避免工具内事件与调度器投递事件双发导致语义漂移（T11 接线只改调度器投递点）。
 *
 * 会话 fail-closed（quality review）：畸形/净化成员会话（`team:t1:` / `team-t1-` 等，
 * pattern 命中但解析失败）抛 team_actor_unknown——不得按 captain 语义放行
 * （否则 sender 审计失真为 "captain"），与 update_task 对同形态会话行为一致。
 */
import { randomUUID } from "node:crypto";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { withTeamLock } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { TEAM_MEMBER_SESSION_PATTERN, requireTeamMember, resolveActor, type TeamToolsOptions } from "./teamUtils.js";

export type TeamSendMessageInput = { teamId: string; recipient: string; content: string };
export type TeamSendMessageOutput = { messageId: string; teamId: string; recipient: string; sender: string };

export function createTeamSendMessageTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamSendMessageInput, TeamSendMessageOutput> {
  const { db, scheduler } = options;
  return {
    name: "team_send_message",
    outputSchema: {
      type: "object",
      required: ["messageId", "teamId", "recipient", "sender"],
      properties: {
        messageId: { type: "string" },
        teamId: { type: "string" },
        recipient: { type: "string" },
        sender: { type: "string" },
      },
    },
    description:
      "Send a persistent message to a team member's mailbox. The member is woken (mailbox takes priority over task dispatch); if the captain is offline the message is held until the captain's connection returns. Recipient must be a non-retired member id of the team: members may message each other, and the captain may message any member — members cannot send to the captain (the captain reads messages from their own session).",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "recipient", "content"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        recipient: { type: "string", description: "Member id of the recipient (cannot be the captain)." },
        content: { type: "string", description: "Message content (non-blank)." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamSendMessageOutput>> => {
      const actor = resolveActor(context.sessionId);
      // 畸形/净化成员会话（pattern 命中但解析失败，actor === undefined）fail-closed：
      // 信息丢失不可判定身份，绝不放行（防止 sender 审计失真为 "captain"）
      if (actor === undefined && TEAM_MEMBER_SESSION_PATTERN.test(context.sessionId ?? "")) {
        throw new SatiToolRuntimeError("team_actor_unknown", "无法判定调用者会话身份（成员会话形态畸形）");
      }
      // 输入校验（锁外，纯函数；M5 风格对齐 create_task subject 校验）
      if (input.content.trim() === "") {
        throw new SatiToolRuntimeError("invalid_tool_input", "消息内容不能为空");
      }
      const senderId = actor === undefined || actor.captain ? "captain" : requireTeamMember(db, actor, input.teamId);
      let messageId = "";
      await withTeamLock(input.teamId, async () => {
        const team = db.getTeam(input.teamId);
        if (team === undefined) {
          throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
        }
        const recipient = db.getMember(input.recipient);
        if (recipient === undefined || recipient.teamId !== input.teamId) {
          throw new SatiToolRuntimeError("team_not_member", `收件人不存在：${input.recipient}`);
        }
        if (db.isRetired(recipient.sessionKey)) {
          throw new SatiToolRuntimeError("team_member_retired", `收件人已退休：${input.recipient}`);
        }
        messageId = `msg-${randomUUID().slice(0, 8)}`;
        db.insertMessage({
          id: messageId,
          teamId: input.teamId,
          sender: senderId,
          recipient: input.recipient,
          content: input.content,
          createdAt: new Date().toISOString(),
        });
        // 不 emit：message_delivered 由调度器 ack 路径发出（单事件语义，见文件头注释）
      });
      // 锁外唤醒收件人（kickMember 内部自己拿锁，防重入死锁——T5 review 定型；fire-and-forget）
      void scheduler.kickMember(input.teamId, input.recipient).catch(() => undefined);
      return {
        content: [{ type: "text", text: `team_send_message messageId=${messageId} recipient=${input.recipient}` }],
        data: { messageId, teamId: input.teamId, recipient: input.recipient, sender: senderId },
      };
    },
  };
}

/**
 * 成员邮箱工具（M3）：team_send_message——队长或成员投递持久消息（复用 mailbox 租约写入），
 * 锁外 kickMember(recipient) 触发既有「邮箱优先」投递路径（unreadMessages → claimDelivery → wake → ack）。
 * 作业面（domain: "team"）。注意：captain 离线时调度器暂停投递（消息留邮箱，队长回来再投）——
 * 与 isCaptainOnline 统一语义。emit 锁内发出（同步入队，T5/T6 惯例），路由真实队长
 * （team.captainSessionKey，不假设调用者）。
 */
import { randomUUID } from "node:crypto";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { withTeamLock } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { requireTeamMember, resolveActor, type TeamToolsOptions } from "./teamUtils.js";

export type TeamSendMessageInput = { teamId: string; recipient: string; content: string };
export type TeamSendMessageOutput = { messageId: string; teamId: string; recipient: string; sender: string };

export function createTeamSendMessageTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamSendMessageInput, TeamSendMessageOutput> {
  const { db, scheduler, emit } = options;
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
      "Send a persistent message to a team member's mailbox. The member is woken (mailbox takes priority over task dispatch); if the captain is offline the message is held until the captain's connection returns. Team members may message each other; the captain may message any member. Recipient must be a non-retired member of the team.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "recipient", "content"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        recipient: { type: "string", description: "Member id of the recipient." },
        content: { type: "string", description: "Message content." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamSendMessageOutput>> => {
      const actor = resolveActor(context.sessionId);
      // 非队长会话须为团队成员（成员身份校验；sessionId 缺失 fail-closed 按 captain 语义走到锁内 getTeam 复查）
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
        emit(team.captainSessionKey, {
          type: "message_delivered",
          teamId: input.teamId,
          recipient: input.recipient,
          sender: senderId,
        });
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

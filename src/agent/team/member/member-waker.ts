/**
 * 成员唤醒：followup = 构造成员 sessionKey 的 gateway.submitTurn。
 *
 * 不直接拼 AgentLoop/TurnRunner——走 submitTurn 整条链保住 TurnRunner 内的
 * PatentOutputGate（审批门禁）、事件广播与 usage 记账。转录写入与上下文重建
 * 由 gateway 内部 resume 路径完成（与 runTaskResumeScan 的续算接线同构）。
 */
import type { GatewayEvent, GatewaySubmitTurnInput } from "../../../gateway/protocol/types.js";
import type { TeamDb } from "../storage/team-db.js";

export type MemberGateway = Pick<import("../../../gateway/protocol/types.js").Gateway, "submitTurn">;

export class TeamMemberNotFoundError extends Error {
  constructor(memberId: string) {
    super(`Team member not found: ${memberId}`);
    this.name = "TeamMemberNotFoundError";
  }
}

export class TeamMemberRetiredError extends Error {
  constructor(memberId: string) {
    super(`Team member is retired: ${memberId}`);
    this.name = "TeamMemberRetiredError";
  }
}

export type WakeMemberOptions = {
  syntheticMessages?: Array<{ text: string; purpose?: string }>;
  /** 每事件回调（审批转发层接线点，Task 6）。回调不得抛出——抛出会中止成员 turn。 */
  onEvent?: (event: GatewayEvent) => void;
};

export async function wakeMember(
  db: TeamDb,
  gateway: MemberGateway,
  memberId: string,
  followupMessage: string,
  options: WakeMemberOptions = {},
): Promise<void> {
  const member = db.getMember(memberId);
  if (!member) {
    throw new TeamMemberNotFoundError(memberId);
  }
  if (db.isRetired(member.sessionKey)) {
    throw new TeamMemberRetiredError(memberId);
  }
  db.updateMemberStatus(memberId, "working");
  try {
    const input: GatewaySubmitTurnInput = {
      sessionKey: member.sessionKey,
      channelKey: "cron",
      message: followupMessage,
      canPrompt: false,
      ...(options.syntheticMessages ? { syntheticMessages: options.syntheticMessages } : {}),
    };
    for await (const event of gateway.submitTurn(input)) {
      options.onEvent?.(event);
    }
  } finally {
    db.updateMemberStatus(memberId, "idle");
  }
}

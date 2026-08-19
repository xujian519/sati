/**
 * 审批冒泡转发层：GatewayApprovalBus 按 sessionKey 分桶，成员挂起的审批不会
 * 自动出现在队长 UI。本层把成员会话的 approval_pending 转发到队长会话 watcher
 * （审批卡片标注成员来源），队长的决定经 approvalDecide 回写成员 sessionKey。
 */
import type { GatewayEvent } from "../../../gateway/protocol/types.js";
import type { TeamDb, TeamMemberRow } from "../storage/team-db.js";

export type TeamApprovalForwarderOptions = {
  db: TeamDb;
  /**
   * 生产接线到 InProcessGateway.emitForSession（src/gateway/client/InProcessGateway.ts:282）。
   * 返回 false = 队长当前无活跃 watcher，事件丢弃——best-effort 推送：挂起态不丢
   * （bus 按成员 sessionKey 留存 + approvalListPending 兜底），只是队长侧无实时卡片。
   */
  emitForSession: (sessionKey: string, event: GatewayEvent) => boolean;
  /** 生产接线到 gateway.approvalDecide（src/gateway/client/InProcessGateway.ts:755）。 */
  approvalDecide: (input: {
    sessionKey: string;
    pendingIndex: number;
    verdict: "adopted" | "rejected";
    feedback?: string;
  }) => Promise<{ delivered: boolean }>;
};

export class TeamApprovalForwarder {
  constructor(private readonly options: TeamApprovalForwarderOptions) {}

  /** 成员回合事件入口：由 wakeMember 的 onEvent 回调接线（Task 4）。 */
  handleMemberEvent(member: TeamMemberRow, event: GatewayEvent): void {
    if (event.type !== "approval_pending") {
      return;
    }
    const team = this.options.db.getTeam(member.teamId);
    if (!team) {
      return;
    }
    // 队长 UI 以 sessionKey 匹配自己的 watcher；成员来源保留在 sessionId。
    this.options.emitForSession(team.captainSessionKey, {
      ...event,
      sessionKey: team.captainSessionKey,
      sessionId: member.sessionKey,
    });
  }

  /** 队长审批决定回写成员会话（校验 captain 与 member 同队）。 */
  async decide(
    captainSessionKey: string,
    memberSessionKey: string,
    pendingIndex: number,
    verdict: "adopted" | "rejected",
    feedback?: string,
  ): Promise<{ delivered: boolean }> {
    const member = this.findMemberBySessionKey(memberSessionKey);
    if (!member) {
      return { delivered: false };
    }
    const team = this.options.db.getTeam(member.teamId);
    if (!team || team.captainSessionKey !== captainSessionKey) {
      return { delivered: false };
    }
    return this.options.approvalDecide({ sessionKey: memberSessionKey, pendingIndex, verdict, feedback });
  }

  private findMemberBySessionKey(sessionKey: string): TeamMemberRow | undefined {
    return this.options.db.listMembers().find(member => member.sessionKey === sessionKey);
  }
}

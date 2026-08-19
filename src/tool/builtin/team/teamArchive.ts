/**
 * 团队归档工具（M3）：team_archive——锁内复查（非 archived）→ 置 archivedAt + 全部成员
 * 退休（reason: "team_archived"）→ team_archived 事件。调度器认领前检查 archivedAt（跳过）。
 * 归档不可逆（无 unarchive；重建 = 新队）。管理面（domain: "team:manage"）。
 * 权限与事件路由（T5 review 定型）：锁内首行 requireTeamCaptain 同队自守
 * （team_not_found/team_not_captain 由此抛），事件发往 team.captainSessionKey
 * （emit 目标 = 团队队长会话，非调用方 context.sessionId）。
 */
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { withTeamLock } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { requireTeamCaptain, type TeamToolsOptions } from "./teamUtils.js";

export type TeamArchiveInput = { teamId: string };
export type TeamArchiveOutput = { teamId: string; archived: boolean };

export function createTeamArchiveTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamArchiveInput, TeamArchiveOutput> {
  const { db, emit } = options;
  return {
    name: "team_archive",
    outputSchema: {
      type: "object",
      required: ["teamId", "archived"],
      properties: { teamId: { type: "string" }, archived: { type: "boolean" } },
    },
    description:
      "Archive a team (irreversible): the team is marked archived, all members are retired (no longer woken), and the scheduler stops dispatching to it. Tasks and messages remain readable. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId"],
      additionalProperties: false,
      properties: { teamId: { type: "string", description: "Team id." } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamArchiveOutput>> => {
      await withTeamLock(input.teamId, async () => {
        // 锁内首行同队自守：未知团队/非队长/异队队长一律拒绝（requireTeamCaptain 抛 team_not_found / team_not_captain）
        const team = requireTeamCaptain(db, context.sessionId, input.teamId);
        if (team.archivedAt !== undefined) {
          throw new SatiToolRuntimeError("team_already_archived", `团队已归档：${input.teamId}`);
        }
        const archivedAt = new Date().toISOString();
        db.archiveTeam(input.teamId, archivedAt);
        // 成员全退休（reason: "team_archived"）——退休成员不再被唤醒
        for (const member of db.listMembers().filter(m => m.teamId === input.teamId)) {
          if (!db.isRetired(member.sessionKey)) {
            db.insertRetired(member.sessionKey, member.id, "team_archived");
          }
        }
        emit(team.captainSessionKey, { type: "team_archived", teamId: input.teamId });
      });
      return {
        content: [{ type: "text", text: `team_archive teamId=${input.teamId} archived` }],
        data: { teamId: input.teamId, archived: true },
      };
    },
  };
}

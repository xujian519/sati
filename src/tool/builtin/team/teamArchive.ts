/**
 * 团队归档工具（M3）：team_archive——锁内复查（非 archived）→ 置 archivedAt + 全部成员
 * 退休（reason: "team_archived"）→ team_archived 事件。调度器认领前检查 archivedAt（跳过）。
 * 归档不可逆（无 unarchive；重建 = 新队）。管理面（domain: "team:manage"）。
 * 权限与事件路由（T5 review 定型）：锁内首行 requireTeamCaptain 同队自守
 * （team_not_found/team_not_captain 由此抛），事件发往 team.captainSessionKey
 * （emit 目标 = 团队队长会话，非调用方 context.sessionId）。
 *
 * 阶段 4：归档时收集团队产出（成员/任务/worker/输出摘要）为材料清单，附在返回
 * content 供后续 briefing deck 生成（html-patent-briefing-deck）引用——确定性
 * 收集、无 LLM，出稿由 agent 据清单另行执行（归档工具不耦合 LLM 生成）。
 */
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { withTeamLock, type TeamDb } from "../../../agent/team/index.js";
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
      let materialSummary = "";
      await withTeamLock(input.teamId, async () => {
        // 锁内首行同队自守：未知团队/非队长/异队队长一律拒绝（requireTeamCaptain 抛 team_not_found / team_not_captain）
        const team = requireTeamCaptain(db, context.sessionId, input.teamId);
        if (team.archivedAt !== undefined) {
          throw new SatiToolRuntimeError("team_already_archived", `团队已归档：${input.teamId}`);
        }
        // 阶段 4：归档前收集素材（锁内快照，保证与归档状态一致）。
        materialSummary = collectArchiveMaterials(db, input.teamId);
        const archivedAt = new Date().toISOString();
        // I-1 review（T8）：归档 + 成员退休同一事务（原子化）——中途失败整体回滚，
        // 不留「已归档但成员未退休 / 已退休但未归档」的半态（僵尸成员可被唤醒的窗口）。
        db.transaction(() => {
          db.archiveTeam(input.teamId, archivedAt);
          // 成员全退休（reason: "team_archived"）——退休成员不再被唤醒
          for (const member of db.listMembers().filter(m => m.teamId === input.teamId)) {
            if (!db.isRetired(member.sessionKey)) {
              db.insertRetired(member.sessionKey, member.id, "team_archived");
            }
          }
        });
        // emit 在事务提交后（锁内、事务外）：内存广播失败不回滚已提交的数据（I-1 review）
        emit(team.captainSessionKey, { type: "team_archived", teamId: input.teamId });
      });
      return {
        content: [{ type: "text", text: `team_archive teamId=${input.teamId} archived\n\n${materialSummary}` }],
        data: { teamId: input.teamId, archived: true },
      };
    },
  };
}

/** 归档材料清单（阶段 4）：成员 + 任务（状态/worker/输出摘要），供 briefing deck 生成引用。 */
function collectArchiveMaterials(db: TeamDb, teamId: string): string {
  const members = db.listMembers().filter(m => m.teamId === teamId);
  const tasks = db.listTasks(teamId);
  const memberLines = members.map(m => `- ${m.id} (${m.roleSlug})`).join("\n") || "（无成员）";
  const taskLines =
    tasks
      .map(t => {
        const worker = t.workerName !== undefined ? ` [worker: ${t.workerName}]` : "";
        const output = t.output !== undefined && t.output.trim().length > 0 ? ` — ${t.output.slice(0, 120)}` : "";
        const assignee = t.assigneeId !== undefined ? ` (${t.assigneeId})` : "";
        return `- ${t.id} [${t.status}]${assignee} ${t.subject}${worker}${output}`;
      })
      .join("\n") || "（无任务）";
  return ["【归档材料清单】", `成员（${members.length}）:`, memberLines, `任务（${tasks.length}）:`, taskLines].join(
    "\n",
  );
}

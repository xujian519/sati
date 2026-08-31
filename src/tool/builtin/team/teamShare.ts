/**
 * 团队共享黑板工具（P1-4）：team_share_write / team_share_read。
 *
 * 成员（队长亦可）把跨回合/跨成员共享上下文写入团队黑板，后续成员（含下一回合）可读。
 * 落盘 {cwd}/.sati/team-workspace/{teamId}/share.jsonl（每条 JSONL 一行，按 (key, writer,
 * toolCallId) 去重——resume/重放不重复落，与 TeamShare 原语一致）。
 * 作业面（domain: "team"，由注册表集中打标）：P0-1 成员工具隔离后 12 岗保有的作业面集合。
 *
 * 与 team_send_message 差异：邮箱是一次性投递（投递即阅、驱动 wake）；黑板是可反复读的
 * 持久化键值上下文（不驱动调度，成员主动读写）。队长是黑板主消费方（开局注入摘要）。
 *
 * 事件语义唯一化：team_share_updated 由本工具写路径发出（含 teamId/writer/key）；
 * read 路径只读不 emit。写失败仅内存可见（降级 warn，不抛错——与 TeamShare 原语
 * appendLine 降级语义一致，审计侧以文件为准；板书是显式共享动作但单条失败不阻断会话）。
 * 会话 fail-closed（assertActorParseable）：畸形/净化成员会话抛 team_actor_unknown，
 * 与 team_send_message / team_status 对同形态会话行为一致。
 */
import { join } from "node:path";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { TeamShare, type TeamShareEntry } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import {
  assertActorParseable,
  requireTeamCaptain,
  requireTeamMember,
  resolveActor,
  type TeamToolsOptions,
} from "./teamUtils.js";

/** 黑板落盘目录（团队隔离：每团队独立目录；cwd = 当前 workspace 根）。 */
export function teamSharePath(cwd: string, teamId: string): string {
  return join(cwd, ".sati", "team-workspace", teamId, "share.jsonl");
}

/** 写入者解析：队长会话 → "captain"；成员会话 → memberId；无 sessionId 主会话直调 → "captain"。 */
function resolveWriter(
  db: TeamToolsOptions["db"],
  actor: ReturnType<typeof resolveActor>,
  sessionId: string | undefined,
  teamId: string,
): string {
  if (actor === undefined) return "captain";
  if (actor.captain) {
    // 队长路径同队校验：异队队长会话不得写入本队黑板（requireTeamCaptain 需原始 sessionId）
    requireTeamCaptain(db, sessionId, teamId);
    return "captain";
  }
  return requireTeamMember(db, actor, teamId);
}

function isValidKey(key: string): boolean {
  return key.trim().length > 0 && key.length <= 200;
}

export type TeamShareWriteInput = { teamId: string; key: string; value: string };
export type TeamShareWriteOutput = { key: string; writer: string; teamId: string; count: number };

export function createTeamShareWriteTool(
  options: Pick<TeamToolsOptions, "db" | "emit">,
): SatiToolDefinition<TeamShareWriteInput, TeamShareWriteOutput> {
  const { db, emit } = options;
  return {
    name: "team_share_write",
    outputSchema: {
      type: "object",
      required: ["key", "writer", "teamId", "count"],
      properties: {
        key: { type: "string" },
        writer: { type: "string" },
        teamId: { type: "string" },
        count: { type: "number" },
      },
    },
    description:
      "Write a key-value entry to the team's shared blackboard (a durable, re-readable workspace-level context board). Unlike team_send_message (one-shot delivery that wakes the recipient), the blackboard is read repeatedly by members and the captain across turns. Use it to publish shared conclusions, search scope, or intermediate artifacts that teammates should see when they start. Deduplicated by (key, writer, toolCallId), so replay/resume never duplicates.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "key", "value"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        key: { type: "string", description: "Blackboard key (non-blank, <=200 chars)." },
        value: { type: "string", description: "Value to store (shared context text or JSON string)." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamShareWriteOutput>> => {
      if (!isValidKey(input.key)) {
        throw new SatiToolRuntimeError("invalid_tool_input", "黑板 key 不能为空且长度需 <= 200");
      }
      const actor = resolveActor(context.sessionId);
      // 畸形/净化成员会话 fail-closed（assertActorParseable）：信息丢失不可判定身份，绝不放行
      assertActorParseable(actor, context.sessionId);
      const team = db.getTeam(input.teamId);
      if (team === undefined) {
        throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
      }
      const writer = resolveWriter(db, actor, context.sessionId, input.teamId);
      const entry: TeamShareEntry = {
        key: input.key,
        value: input.value,
        writer,
        ts: new Date().toISOString(),
        // 溯源：turnId 走上下文；toolCallId 去重键（resume/重放不重复落——有 currentToolCallId 才参与，
        // 无则每次为独立写入，同 key 多写保留历史版本）
        ...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
        ...(context.currentToolCallId !== undefined ? { toolCallId: context.currentToolCallId } : {}),
      };
      const board = new TeamShare(teamSharePath(context.cwd, input.teamId));
      board.write(entry);
      emit(team.captainSessionKey, {
        type: "team_share_updated",
        teamId: input.teamId,
        writer: entry.writer,
        key: entry.key,
      });
      return {
        content: [
          { type: "text", text: `team_share_write key=${entry.key} writer=${entry.writer} count=${board.size()}` },
        ],
        data: { key: entry.key, writer: entry.writer, teamId: input.teamId, count: board.size() },
      };
    },
  };
}

export type TeamShareReadInput = { teamId: string; key?: string; limit?: number };
export type TeamShareReadOutput = { entries: TeamShareEntry[]; keys: string[] };

export function createTeamShareReadTool(
  options: Pick<TeamToolsOptions, "db" | "emit">,
): SatiToolDefinition<TeamShareReadInput, TeamShareReadOutput> {
  const { db } = options;
  return {
    name: "team_share_read",
    outputSchema: {
      type: "object",
      required: ["entries", "keys"],
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            required: ["key", "value", "writer", "ts"],
            properties: {
              key: { type: "string" },
              value: { type: "string" },
              writer: { type: "string" },
              ts: { type: "string" },
            },
          },
        },
        keys: { type: "array", items: { type: "string" } },
      },
    },
    description:
      "Read entries from the team's shared blackboard. Omitting `key` returns every key and its latest value (bounded by `limit`); passing `key` returns that entry. Use it to see shared conclusions / search scope / intermediate artifacts the team has published via team_share_write before starting your turn.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        key: { type: "string", description: "Optional key to read (omit to read all keys)." },
        limit: { type: "number", description: "Max entries to return (default 20)." },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamShareReadOutput>> => {
      const actor = resolveActor(context.sessionId);
      // 畸形/净化成员会话 fail-closed（assertActorParseable）
      assertActorParseable(actor, context.sessionId);
      if (actor !== undefined && !actor.captain) {
        requireTeamMember(db, actor, input.teamId); // 成员级校验（仅校验身份）
      } else if (actor !== undefined) {
        // 队长路径同队校验：异队队长会话不得读取本队黑板（跨队信息泄露面）
        requireTeamCaptain(db, context.sessionId ?? "", input.teamId);
      }
      const team = db.getTeam(input.teamId);
      if (team === undefined) {
        throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
      }
      const board = new TeamShare(teamSharePath(context.cwd, input.teamId));
      const limit = input.limit && input.limit > 0 ? input.limit : 20;
      let entries: TeamShareEntry[];
      if (input.key !== undefined) {
        const entry = board.read(input.key);
        entries = entry === undefined ? [] : [entry];
      } else {
        // 全量：每 key 取最新值（倒序），limit 截断——与 description "every key and its latest value" 对齐
        entries = board.latestValues().slice(0, limit);
      }
      return {
        content: [{ type: "text", text: `team_share_read entries=${entries.length}` }],
        data: { entries, keys: board.keys() },
      };
    },
  };
}

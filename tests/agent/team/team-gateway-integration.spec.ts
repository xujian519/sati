/**
 * 集成：createLocalGateway 真实接线——成员创建 → 唤醒（fake model 驱动）→ 转录落盘 → 冷恢复扫描。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../../src/cli/createLocalGateway.js";
import { createTeamMember, wakeMember } from "../../../src/agent/team/index.js";
import type { ModelRuntime } from "../../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../src/model/protocol/capabilities.js";

test("集成：成员唤醒经 submitTurn 整条链产出转录，冷恢复可续", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-integration-"));
  // createLocalGateway 对空目录启动要求 config 含 agent/model 段（缺失为致命诊断），
  // 写最小 sati.yaml 满足合法性；真实模型层被 __testModelFactory 替换，provider 仅为占位。
  await writeFile(
    join(root, "sati.yaml"),
    [
      "schemaVersion: 1",
      "agent:",
      "  model: deepseek/deepseek-v4-flash",
      "model:",
      "  providers:",
      "    deepseek:",
      "      apiKey: test-key",
      "      models:",
      "        deepseek-v4-flash: {}",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    // 隔离外部环境（SATI_TEAMS_DB 等）：teams.db 必须落在 mkdtemp 临时目录内
    env: {},
    __testModelFactory: (): ModelRuntime => ({
      // 一次工具调用也不做的单轮模型：直接产出文本后结束
      stream: async function* () {
        yield { type: "text_delta", text: "已完成检索。" };
      },
      complete: async () => {
        throw new Error("unused");
      },
      getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
      getMultimodal: () => ({ input: ["text"] }),
      getProviderProtocol: () => undefined,
      getProviderBaseUrl: () => undefined,
    }),
  });
  try {
    // 接线：createLocalGateway 结果新增 team 子系统句柄（本任务加入）
    const team = result.teamSubsystem;
    assert.ok(team, "teamSubsystem 未接线");
    team.db.upsertTeam({
      id: "t1",
      name: "专利团队",
      captainSessionKey: "cap-1",
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    createTeamMember(team.db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "patent-searcher",
      modelRoute: { provider: "fake", model: "fake-model" },
    });

    await wakeMember(team.db, result.gateway, "m1", "检索任务 T-1");
    assert.equal(team.db.getMember("m1")?.status, "idle");

    // 成员转录由 gateway 内部写入（team: 前缀 sessionKey → chatDir 根 .jsonl）
    const { readTranscript } = await import("../../../src/session/transcript/TranscriptReader.js");
    const { getPilotProjectChatDir } = await import("../../../src/pilot/index.js");
    const { sanitizeSessionIdForPath } = await import("../../../src/session/storage/ProjectSessionStorage.js");
    const chatDir = getPilotProjectChatDir(root, root);
    const transcript = await readTranscript(join(chatDir, `${sanitizeSessionIdForPath("team:t1:m1")}.jsonl`));
    assert.ok(transcript.entries.length > 0, "成员转录应有条目");
    assert.ok(transcript.entries.some(entry => entry.type === "accepted_input"));

    // 主会话扫描看不到成员（转录隔离生效）
    const { listProjectSessions } = await import("../../../src/session/storage/SessionList.js");
    const sessions = await listProjectSessions({ projectRoot: root, pilotHome: root });
    assert.ok(!sessions.some(session => session.sessionId === "team:t1:m1"));

    // 健康成员不会被冷恢复误扫（走接线面句柄，覆盖 hasPendingApprovals 闭包与日志路径）
    const scan = await team.runMemberScan();
    assert.equal(scan.resumed, 0);
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

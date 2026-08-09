import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildChatDigest, extractAllUserPrompts } from "../../../src/always-on/context/ChatDigestBuilder.js";
import { getPilotProjectChatDir } from "../../../src/pilot/paths.js";

const FIXED_NOW = new Date("2026-08-03T10:00:00.000Z");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function acceptedInputLine(...texts: string[]): string {
  return JSON.stringify({
    type: "accepted_input",
    messages: [{ content: texts.map(text => ({ type: "text", text })) }],
  });
}

describe("extractAllUserPrompts", () => {
  const source = [
    acceptedInputLine("first prompt"),
    acceptedInputLine("second prompt"),
    '{"type":"assistant_text_delta","text":"ignore me"}',
  ].join("\n");

  it("提取所有 accepted_input 中的文本 prompt", () => {
    assert.deepEqual(extractAllUserPrompts(source, 8, 500), ["first prompt", "second prompt"]);
  });

  it("按文本去重（head/tail 重叠场景）", () => {
    // 同一文本出现多次只保留一次
    const dup = `${acceptedInputLine("repeat")}\n${acceptedInputLine("repeat")}\n${acceptedInputLine("unique")}`;
    assert.deepEqual(extractAllUserPrompts(dup, 8, 500), ["repeat", "unique"]);
  });

  it("maxPrompts 达到上限立即停止（后续行不再解析）", () => {
    const many = [acceptedInputLine("p1"), acceptedInputLine("p2"), acceptedInputLine("p3"), "{ not json"].join("\n");
    assert.deepEqual(extractAllUserPrompts(many, 2, 500), ["p1", "p2"]);
  });

  it("maxPrompts=0 → 返回空数组", () => {
    assert.deepEqual(extractAllUserPrompts(source, 0, 500), []);
  });

  it("单条消息多个 text 块全部提取", () => {
    const line = acceptedInputLine("part one", "part two");
    assert.deepEqual(extractAllUserPrompts(line, 8, 500), ["part one", "part two"]);
  });

  it("maxLength 截断文本并追加省略号", () => {
    const long = acceptedInputLine("x".repeat(30));
    assert.deepEqual(extractAllUserPrompts(long, 8, 10), [`${"x".repeat(10)}...`]);
    // 恰好等于 maxLength 不截断
    const exact = acceptedInputLine("abcdefghij");
    assert.deepEqual(extractAllUserPrompts(exact, 8, 10), ["abcdefghij"]);
  });

  it("非 text 块（tool 调用等）被过滤", () => {
    const line = JSON.stringify({
      type: "accepted_input",
      messages: [
        {
          content: [
            { type: "text", text: "keep me" },
            { type: "tool_result", text: "drop me" },
            { type: "image", url: "https://x/y.png" },
          ],
        },
      ],
    });
    assert.deepEqual(extractAllUserPrompts(line, 8, 500), ["keep me"]);
  });

  it("空白文本被过滤；无 accepted_input 的行被跳过；畸形 JSON 行跳过", () => {
    const messy = [
      acceptedInputLine("   "),
      acceptedInputLine("ok"),
      '{"type":"assistant_text_delta","text":"nope"}',
      "{ broken json",
      "not json at all",
      "",
    ].join("\n");
    assert.deepEqual(extractAllUserPrompts(messy, 8, 500), ["ok"]);
  });

  it("CRLF 行分隔正常解析", () => {
    const crlf = `${acceptedInputLine("a")}\r\n${acceptedInputLine("b")}`;
    assert.deepEqual(extractAllUserPrompts(crlf, 8, 500), ["a", "b"]);
  });

  it("无匹配内容 → 空数组", () => {
    assert.deepEqual(extractAllUserPrompts("", 8, 500), []);
    assert.deepEqual(extractAllUserPrompts("plain text without json", 8, 500), []);
  });
});

describe("buildChatDigest（真实临时目录集成）", () => {
  function setupChat(entries: Array<{ name: string; lines: string[] }>): { projectRoot: string; pilotHome: string } {
    const pilotHome = mkdtempSync(join(tmpdir(), "sati-aon-digest-"));
    tempDirs.push(pilotHome);
    const projectRoot = mkdtempSync(join(tmpdir(), "sati-aon-digest-proj-"));
    tempDirs.push(projectRoot);

    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    mkdirSync(chatDir, { recursive: true });
    for (const entry of entries) {
      writeFileSync(join(chatDir, entry.name), entry.lines.join("\n") + "\n", "utf8");
    }
    return { projectRoot, pilotHome };
  }

  it("聚合最近会话的 userPrompts 与 aliasMap", async () => {
    const { projectRoot, pilotHome } = setupChat([
      { name: "sess-1.jsonl", lines: [acceptedInputLine("first prompt"), acceptedInputLine("second prompt")] },
    ]);

    const digest = await buildChatDigest({ projectRoot, pilotHome, now: () => FIXED_NOW });

    assert.equal(digest.generatedAt, FIXED_NOW.toISOString());
    assert.equal(digest.sessions.length, 1);
    const session = digest.sessions[0]!;
    assert.equal(session.sessionId, "sess-1");
    assert.equal(session.alias, "chat_1");
    assert.deepEqual(session.userPrompts, ["first prompt", "second prompt"]);
    assert.equal(digest.aliasMap.get("chat_1"), "sess-1");
  });

  it("排除 always-on-execute: 内部会话", async () => {
    const { projectRoot, pilotHome } = setupChat([
      { name: "sess-1.jsonl", lines: [acceptedInputLine("real user prompt")] },
      { name: "always-on-execute:abc.jsonl", lines: [acceptedInputLine("internal execution prompt")] },
    ]);

    const digest = await buildChatDigest({ projectRoot, pilotHome });

    assert.equal(digest.sessions.length, 1);
    assert.equal(digest.sessions[0]!.sessionId, "sess-1");
    for (const session of digest.sessions) {
      assert.ok(!session.sessionId.startsWith("always-on-execute:"));
    }
  });

  it("无用户 prompt 的会话被跳过（无 summary 或空 prompts）", async () => {
    const { projectRoot, pilotHome } = setupChat([
      { name: "no-input.jsonl", lines: ['{"type":"assistant_text_delta","text":"only assistant"}'] },
    ]);

    const digest = await buildChatDigest({ projectRoot, pilotHome });
    assert.deepEqual(digest.sessions, []);
    assert.deepEqual([...digest.aliasMap], []);
  });

  it("maxPromptsPerSession / maxPromptLength 生效", async () => {
    const { projectRoot, pilotHome } = setupChat([
      {
        name: "sess-1.jsonl",
        lines: [acceptedInputLine("short one"), acceptedInputLine("verylong".repeat(5))],
      },
    ]);

    const digest = await buildChatDigest({
      projectRoot,
      pilotHome,
      maxPromptsPerSession: 1,
      maxPromptLength: 8,
    });
    const session = digest.sessions[0]!;
    assert.equal(session.userPrompts.length, 1);
    assert.match(session.userPrompts[0]!, /^.{8}\.\.\.$/);
  });

  it("maxSessions 限制参与聚合的会话数", async () => {
    const { projectRoot, pilotHome } = setupChat([
      { name: "a.jsonl", lines: [acceptedInputLine("from a")] },
      { name: "b.jsonl", lines: [acceptedInputLine("from b")] },
    ]);

    const digest = await buildChatDigest({ projectRoot, pilotHome, maxSessions: 1 });
    assert.equal(digest.sessions.length, 1);
    // 无会话限制时两个都在
    const full = await buildChatDigest({ projectRoot, pilotHome });
    assert.equal(full.sessions.length, 2);
  });
});

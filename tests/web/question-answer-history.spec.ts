/**
 * 历史回放保留问答卡片的结构化数据（questions + answers）。
 * live 路径已在 `eventMapping` 透传 `toolUseResult`；历史路径此前只保留
 * plan/search payload，刷新后内联问答卡片退化成纯文本。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toCanonicalToolResultBlock } from "../../src/tool/protocol/result.js";
import { flattenCanonicalMessage } from "../../src/web/server/webMessageFlatten.js";

const questions = [
  {
    header: "Scope",
    question: "Which paths?",
    multiSelect: true,
    options: [
      { label: "A, B", description: "Combined path" },
      { label: "C", description: "Another path" },
    ],
  },
];
const answers = { "Which paths?": ["A, B", "C", "Custom, answer"] };

for (const toolName of ["ask_user_question", "AskUserQuestion"]) {
  test(`${toolName} 历史回放保留 questions 与 answers`, () => {
    const block = toCanonicalToolResultBlock({
      type: "success",
      toolCallId: "question-call",
      toolName,
      content: [{ type: "text", text: "answered" }],
      data: { questions, answers },
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    });

    const rows = flattenCanonicalMessage({ role: "user", content: [block] }, { index: 0, sessionKey: "session-id" });
    const row = rows.find(item => item.kind === "tool_result");

    assert.deepEqual(row?.payload, { questions, answers });
  });
}

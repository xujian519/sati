import { describe, expect, it } from "vitest";
import { messagesToTurns, type NormalizedMessage } from "./projection";

const user = (text: string, entryId = "u1"): NormalizedMessage => ({
  kind: "text",
  role: "user",
  text,
  entryId,
});
const assistant = (text: string, kind = "text", entryId = "a1"): NormalizedMessage => ({
  kind,
  role: "assistant",
  text,
  entryId,
});
const toolUse = (callId: string, name: string, args: string): NormalizedMessage => ({
  kind: "tool_use",
  role: "assistant",
  toolId: callId,
  toolName: name,
  text: args,
});
const toolResult = (callId: string, result: string): NormalizedMessage => ({
  kind: "tool_result",
  role: "tool",
  toolId: callId,
  text: result,
});

describe("messagesToTurns", () => {
  it("ignores runtime-context messages", () => {
    const turns = messagesToTurns([
      { kind: "system_prompt", role: "system", text: "sys" },
      { kind: "request_header", role: "system", text: "hdr" },
      { kind: "turn_result", role: "system", text: "res" },
      { kind: "retry_schedule", role: "system", text: "retry" },
      user("hi"),
      assistant("hello"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].question).toBe("hi");
    expect(turns[0].answer).toBe("hello");
  });

  it("pairs a question with the following answer", () => {
    const turns = messagesToTurns([user("q"), assistant("a")]);
    expect(turns).toEqual([expect.objectContaining({ question: "q", answer: "a", pending: false, error: null })]);
  });

  it("folds tool calls and results into the turn process by callId", () => {
    const turns = messagesToTurns([
      user("q"),
      toolUse("tool-1", "workspace_note", '{"x":1}'),
      toolResult("tool-1", '{"ok":true}'),
      assistant("done"),
    ]);
    const turn = turns[0];
    expect(turn?.process).toHaveLength(1);
    expect(turn?.process[0]).toEqual({
      callId: "tool-1",
      name: "workspace_note",
      arguments: '{"x":1}',
      result: '{"ok":true}',
    });
  });

  it("does not attach a process for a trailing tool result without an assistant reply", () => {
    const turns = messagesToTurns([user("q"), toolResult("tool-9", "orphan")]);
    expect(turns[0].process).toEqual([]);
  });

  it("marks a turn pending on thinking/status messages", () => {
    const turns = messagesToTurns([user("q"), assistant("thinking…", "thinking")]);
    expect(turns[0].pending).toBe(true);
  });

  it("concatenates multiple assistant segments into one answer", () => {
    const turns = messagesToTurns([user("q"), assistant("part one"), assistant("part two")]);
    expect(turns[0].answer).toBe("part one\npart two");
  });
});

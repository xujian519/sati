import test from "node:test";
import assert from "node:assert/strict";
import {
  ASK_USER_QUESTION_HEADER_MAX,
  InMemoryElicitationChannel,
  createAskUserQuestionTool,
  validateHtmlPreview,
} from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("B1.E5 ask_user_question advertises shouldDefer:true", () => {
  const def = createAskUserQuestionTool();
  assert.equal(def.shouldDefer, true);
});

test("B1.E6 read-only / concurrency-safe / requires-user-interaction flags", () => {
  const def = createAskUserQuestionTool();
  assert.equal(def.isReadOnly({} as never), true);
  assert.equal(def.isConcurrencySafe({} as never), true);
  assert.equal(def.requiresUserInteraction?.({} as never), true);
});

test("B1.E8 maxResultBytes = 100_000", () => {
  const def = createAskUserQuestionTool();
  assert.equal(def.maxResultBytes, 100_000);
});

test("B1.E_HTML validateHtmlPreview rejects full document, script, style; accepts fragment; accepts undefined", () => {
  assert.equal(validateHtmlPreview(undefined), null);
  assert.match(
    validateHtmlPreview("<!DOCTYPE html><html><body>hi</body></html>") ?? "",
    /must be an HTML fragment/,
  );
  assert.match(
    validateHtmlPreview("<script>alert(1)</script>") ?? "",
    /<script> or <style>/,
  );
  assert.match(
    validateHtmlPreview("plain text without tags") ?? "",
    /must contain HTML/,
  );
  assert.equal(validateHtmlPreview("<div>hi</div>"), null);
  assert.equal(validateHtmlPreview('<pre style="color:red">code</pre>'), null);
});

test("B1.E1 schema enforces 1-4 questions and 2-4 options", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createAskUserQuestionTool()],
    cwd: workspace.cwd,
    elicitation: new InMemoryElicitationChannel(),
  });
  // 0 questions
  const r0 = await toolRuntime.execute(
    { id: "c", name: "ask_user_question", input: { questions: [] } },
    context,
  );
  assert.equal(r0.type, "error");

  // 1 question with 1 option (below min)
  const r1 = await toolRuntime.execute(
    {
      id: "c",
      name: "ask_user_question",
      input: {
        questions: [
          {
            question: "x?",
            header: "h",
            options: [{ label: "only", description: "d" }],
          },
        ],
      },
    },
    context,
  );
  assert.equal(r1.type, "error");
});

test("B1.E3 uniqueness — duplicate question texts rejected", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createAskUserQuestionTool()],
    cwd: workspace.cwd,
    elicitation: new InMemoryElicitationChannel({ "Same?": "A" }),
  });
  const result = await toolRuntime.execute(
    {
      id: "c",
      name: "ask_user_question",
      input: {
        questions: [
          {
            question: "Same?",
            header: "h1",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
          },
          {
            question: "Same?",
            header: "h2",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
          },
        ],
      },
    },
    context,
  );
  assert.equal(result.type, "error");
});

test("B1.E4 header length limit enforced via validateInput", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createAskUserQuestionTool()],
    cwd: workspace.cwd,
    elicitation: new InMemoryElicitationChannel({ "What?": "A" }),
  });
  const tooLongHeader = "X".repeat(ASK_USER_QUESTION_HEADER_MAX + 1);
  const result = await toolRuntime.execute(
    {
      id: "c",
      name: "ask_user_question",
      input: {
        questions: [
          {
            question: "What?",
            header: tooLongHeader,
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
          },
        ],
      },
    },
    context,
  );
  assert.equal(result.type, "error");
});

test("B1.E10 missing elicitation channel → unsupported_tool", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createAskUserQuestionTool()],
    cwd: workspace.cwd,
    // no elicitation channel
  });
  const result = await toolRuntime.execute(
    {
      id: "c",
      name: "ask_user_question",
      input: {
        questions: [
          {
            question: "What?",
            header: "Pick",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
          },
        ],
      },
    },
    context,
  );
  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "unsupported_tool");
  }
});

test("B1 happy path: in-memory channel returns answer; output uses legacy format", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createAskUserQuestionTool()],
    cwd: workspace.cwd,
    elicitation: new InMemoryElicitationChannel({ "Which?": "Option B" }),
  });

  const result = await toolRuntime.execute(
    {
      id: "c",
      name: "ask_user_question",
      input: {
        questions: [
          {
            question: "Which?",
            header: "Pick",
            options: [
              { label: "Option A", description: "the first" },
              { label: "Option B", description: "the second" },
            ],
          },
        ],
      },
    },
    context,
  );

  assert.equal(result.type, "success");
  if (result.type === "success") {
    const data = result.data as { answers: Record<string, unknown> };
    assert.equal(data.answers["Which?"], "Option B");
    // E9 legacy boilerplate phrase.
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");
    assert.match(text, /User has answered your questions/);
    assert.match(text, /"Which\?"="Option B"/);
  }
});

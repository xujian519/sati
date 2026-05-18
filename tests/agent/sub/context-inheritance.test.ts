import test from "node:test";
import assert from "node:assert/strict";
import {
  applySystemPromptFilters,
  cloneReadFileState,
  SUBAGENT_DEFINITIONS,
} from "../../../src/agent/sub/index.js";

test("C2.S5 cloneReadFileState produces a deep copy", () => {
  const parent = new Map<string, { mtimeMs: number; kind: "text" }>([
    ["/a.txt", { mtimeMs: 1, kind: "text" }],
  ]);
  const cloned = cloneReadFileState(parent);
  assert.notEqual(cloned, parent);
  assert.deepEqual(cloned.get("/a.txt"), parent.get("/a.txt"));
  cloned.set("/b.txt", { mtimeMs: 2, kind: "text" });
  assert.equal(parent.get("/b.txt"), undefined);
});

test("C2.S5 cloneReadFileState handles undefined parent", () => {
  const out = cloneReadFileState(undefined);
  assert.equal(out.size, 0);
});

test("C2.S7 applySystemPromptFilters strips claudeMd for explore", () => {
  const explore = SUBAGENT_DEFINITIONS.explore;
  const sp = `Header.\n<claude-md>important repo rules</claude-md>\nFooter.`;
  const out = applySystemPromptFilters(sp, explore);
  assert.ok(!out.includes("important repo rules"));
  assert.ok(out.includes("Header."));
  assert.ok(out.includes("Footer."));
});

test("C2.S8 applySystemPromptFilters strips git-status for plan", () => {
  const plan = SUBAGENT_DEFINITIONS.plan;
  const sp = `Top.\n<git-status>diff --stat ...</git-status>\nBottom.`;
  const out = applySystemPromptFilters(sp, plan);
  assert.ok(!out.includes("diff --stat"));
  assert.ok(out.includes("Top."));
  assert.ok(out.includes("Bottom."));
});

test("C2.S7 general-purpose retains claudeMd block", () => {
  const gp = SUBAGENT_DEFINITIONS["general-purpose"];
  const sp = `<claude-md>keep me</claude-md>\nrest.`;
  const out = applySystemPromptFilters(sp, gp);
  assert.ok(out.includes("keep me"));
});

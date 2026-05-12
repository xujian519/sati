import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTask, loadAllTasks } from "./taskLoader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PILOTDECK_ROOT = path.resolve(__dirname, "../../..");
const SKILL_DIR = path.join(PILOTDECK_ROOT, "..", "skill");
const TASKS_DIR = path.join(SKILL_DIR, "tasks");

test("parseTask extracts sanity check task correctly", async () => {
  const { readFile } = await import("node:fs/promises");
  const filePath = path.join(TASKS_DIR, "task_00_sanity.md");
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return; // skip if skill dir not available
  }

  const task = parseTask(content, filePath);

  assert.equal(task.taskId, "task_00_sanity");
  assert.equal(task.name, "Sanity Check");
  assert.equal(task.category, "basic");
  assert.equal(task.gradingType, "automated");
  assert.equal(task.timeoutSeconds, 60);
  assert.ok(task.prompt.includes("Hello"));
  assert.ok(task.expectedBehavior.length > 0);
  assert.ok(task.gradingCriteria.length >= 1);
  assert.ok(task.automatedChecks?.includes("def grade"));
  assert.deepEqual(task.workspaceFiles, []);
});

test("parseTask handles workspace_files with inline content", () => {
  const md = `---
id: test_task
name: Test
category: test
grading_type: automated
timeout_seconds: 60
workspace_files:
  - path: "data.txt"
    content: "hello world"
---

## Prompt

Do something.

## Expected Behavior

It works.

## Grading Criteria

- [ ] First criterion
- [ ] Second criterion
`;

  const task = parseTask(md, "/fake/path.md");

  assert.equal(task.taskId, "test_task");
  assert.equal(task.prompt, "Do something.");
  assert.equal(task.workspaceFiles.length, 1);
  const spec = task.workspaceFiles[0];
  assert.ok("content" in spec);
  if ("content" in spec) {
    assert.equal(spec.path, "data.txt");
    assert.equal(spec.content, "hello world");
  }
  assert.deepEqual(task.gradingCriteria, ["First criterion", "Second criterion"]);
});

test("parseTask handles workspace_files with source/dest", () => {
  const md = `---
id: test_asset
name: Test Asset
category: test
grading_type: hybrid
timeout_seconds: 120
grading_weights:
  automated: 0.6
  llm_judge: 0.4
workspace_files:
  - source: quarterly_sales.csv
    dest: quarterly_sales.csv
---

## Prompt

Analyze data.

## Expected Behavior

Writes report.
`;

  const task = parseTask(md, "/fake/path.md");

  assert.equal(task.gradingType, "hybrid");
  assert.deepEqual(task.gradingWeights, { automated: 0.6, llm_judge: 0.4 });
  assert.equal(task.workspaceFiles.length, 1);
  const spec = task.workspaceFiles[0];
  assert.ok("source" in spec);
  if ("source" in spec) {
    assert.equal(spec.source, "quarterly_sales.csv");
    assert.equal(spec.dest, "quarterly_sales.csv");
  }
});

test("loadAllTasks skips multi_session tasks", async () => {
  let tasks;
  try {
    tasks = await loadAllTasks(TASKS_DIR);
  } catch {
    return; // skip if skill dir not available
  }

  assert.ok(tasks.length >= 20, `Expected at least 20 tasks, got ${tasks.length}`);
  assert.ok(tasks.length <= 22, `Expected at most 22 tasks, got ${tasks.length}`);
  const ids = tasks.map((t) => t.taskId);
  assert.ok(!ids.some((id) => id.includes("second_brain")), "task_22 should be excluded");
  assert.ok(ids.includes("task_00_sanity"));
  assert.ok(ids.includes("task_09_files"));
});

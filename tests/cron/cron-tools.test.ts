import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCronRuntime, defaultCronConfig } from "../../src/cron/index.js";

test("CronRuntime exposes the cron tool set with expected safety flags", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-tools-"));
  try {
    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      pilotHome,
      projectKey: "/tmp/projects/sample",
    });
    const tools = runtime.getTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "cron_create",
      "cron_delete",
      "cron_list",
      "cron_stop",
    ]);
    const list = tools.find((tool) => tool.name === "cron_list");
    const create = tools.find((tool) => tool.name === "cron_create");
    assert.equal(list?.isReadOnly({}), true);
    assert.equal(list?.isConcurrencySafe({}), true);
    assert.equal(create?.isReadOnly({}), false);
    assert.equal(create?.isConcurrencySafe({}), false);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("cron_create keeps project fallback from the tool context and assigns a cron session", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-tools-create-"));
  try {
    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      pilotHome,
      projectKey: "/tmp/projects/default",
      now: () => new Date("2026-05-09T12:00:00.000Z"),
      uuid: () => "task-tool",
    });
    const create = runtime.getTools().find((tool) => tool.name === "cron_create");
    assert.ok(create, "expected cron_create to be registered");

    const result = await create.execute(
      {
        message: "tool-driven cron",
        schedule: { type: "once", runAt: "2026-05-09T12:01:00.000Z" },
      },
      {
        sessionId: "web:s_original",
        turnId: "turn-1",
        cwd: "/tmp/projects/from-context",
        permissionMode: "default",
        permissionContext: {} as never,
      } as never,
    );

    const task = (
      result.data as
        | {
            task?: {
              projectKey?: string;
              sessionKey?: string;
              channelKey?: string;
            };
          }
        | undefined
    )?.task;
    assert.equal(task?.projectKey, "/tmp/projects/from-context");
    assert.equal(task?.sessionKey, "cron:task-tool");
    assert.equal(task?.channelKey, "cron");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

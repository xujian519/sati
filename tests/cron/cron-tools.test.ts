import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCronRuntime, defaultCronConfig } from "../../src/cron/index.js";

test("CronRuntime exposes the cron tool set with expected safety flags", () => {
  const politHome = mkdtempSync(join(tmpdir(), "politdeck-cron-tools-"));
  try {
    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      politHome,
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
    rmSync(politHome, { recursive: true, force: true });
  }
});

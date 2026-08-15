/**
 * PilotConfigStore last-good-facts 测试（阶段四 T7.2）。
 *
 * 覆盖：初始加载即记 last-good；坏快照 reload 失败时保留上一代配置、
 * 连续失败计数递增、快照不变。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPilotConfigStoreSync } from "../../../src/pilot/config/PilotConfigStore.js";
import { PILOT_CONFIG_FILE_NAME } from "../../../src/pilot/paths.js";

const MINIMAL_VALID =
  [
    "agent:",
    "  model: deepseek/deepseek-chat",
    "model:",
    "  providers:",
    "    deepseek:",
    "      protocol: openai",
    "      url: https://api.deepseek.com/v1",
    "      apiKey: ${DEEPSEEK_API_KEY}",
    "      models:",
    "        deepseek-chat:",
    "          id: deepseek-chat",
  ].join("\n") + "\n";

test("初始加载即记 last-good；坏快照 reload 保留上一代并递增失败计数", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-pilot-lastgood-"));
  try {
    await writeFile(join(dir, PILOT_CONFIG_FILE_NAME), MINIMAL_VALID, "utf8");
    const store = createPilotConfigStoreSync({ env: { SATI_HOME: dir, DEEPSEEK_API_KEY: "sk-test" } });
    assert.equal(store.getConsecutiveFailures(), 0);
    assert.ok(store.getLastGoodFacts() !== undefined);
    const initialVersion = store.getSnapshot().version;
    const initialProvider = store.getSnapshot().config.model.providers?.deepseek?.id;
    // 写入缺 agent/model 的配置并 reload：fatal 诊断触发失败，但快照不变、
    // last-good 保留、失败计数递增。
    await writeFile(join(dir, PILOT_CONFIG_FILE_NAME), "foo: bar\n", "utf8");
    await assert.rejects(() => store.reload("test"));
    assert.equal(store.getConsecutiveFailures(), 1);
    assert.equal(store.getSnapshot().version, initialVersion);
    assert.equal(store.getSnapshot().config.model.providers?.deepseek?.id, initialProvider);
    assert.equal(store.getLastGoodFacts()?.version, initialVersion);
    // 修复后 reload：失败计数清零。
    await writeFile(join(dir, PILOT_CONFIG_FILE_NAME), MINIMAL_VALID, "utf8");
    const restored = await store.reload("test");
    assert.equal(store.getConsecutiveFailures(), 0);
    assert.ok(restored.version > initialVersion);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

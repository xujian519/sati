/**
 * `ensureRouterConfig` 的三态语义（上游 #588 移植）。
 *
 * 这里是本仓此前**零覆盖**的函数，而它的缺段分支决定了「未配置 router 的用户
 * 会不会凭空多出分类调用」——`router: {enabled: false}` 在网关内部是直通路径，
 * 与「全开默认值」的行为差异只体现在模型调用次数上，不会报错，因此必须有测试钉住。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ensureRouterConfig } from "../../src/cli/routerDefaults.js";
import type { PilotAgentModelSelection } from "../../src/pilot/config/types.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const SELECTION: PilotAgentModelSelection = { id: "p/m", provider: "p", model: "m" };
const DEFAULT_REF = { id: "p/m", provider: "p", model: "m" };

test("ensureRouterConfig: 段缺失 → 关（不构造默认全开配置）", () => {
  assert.deepEqual(ensureRouterConfig(undefined, SELECTION), { enabled: false });
});

test("ensureRouterConfig: 段存在但无 enabled → 开，并补齐默认子段（遗留 opt-in）", () => {
  const result = ensureRouterConfig({}, SELECTION);

  assert.equal(result.enabled, true);
  assert.deepEqual(result.scenarios, { default: DEFAULT_REF });
  assert.deepEqual(result.fallback, { default: [DEFAULT_REF] });
  assert.equal(result.tokenSaver?.enabled, true);
  assert.equal(result.autoOrchestrate?.enabled, true);
  assert.equal(result.stats?.enabled, true);
});

test("ensureRouterConfig: 显式 enabled: false 短路，不补任何子段", () => {
  const result = ensureRouterConfig({ enabled: false, zeroUsageRetry: { enabled: true, maxAttempts: 3 } }, SELECTION);

  assert.deepEqual(result, { enabled: false });
});

test("ensureRouterConfig: 显式 enabled: true 保留用户已写的子段", () => {
  const router: RouterConfig = {
    enabled: true,
    scenarios: { default: { id: "other/model", provider: "other", model: "model" } },
    stats: { enabled: false },
  };

  const result = ensureRouterConfig(router, SELECTION);

  assert.equal(result.enabled, true);
  assert.deepEqual(result.scenarios, { default: { id: "other/model", provider: "other", model: "model" } });
  // 用户显式关掉的 stats 不被默认值覆盖
  assert.equal(result.stats?.enabled, false);
  // 未写的子段照旧补默认值
  assert.deepEqual(result.fallback, { default: [DEFAULT_REF] });
});

test("ensureRouterConfig: 遗留段无 enabled（只有子段）→ 开且保留该子段", () => {
  const result = ensureRouterConfig({ stats: { enabled: false } }, SELECTION);

  assert.equal(result.enabled, true);
  assert.equal(result.stats?.enabled, false);
  assert.deepEqual(result.stats?.baselineModel, DEFAULT_REF);
  assert.deepEqual(result.scenarios, { default: DEFAULT_REF });
});

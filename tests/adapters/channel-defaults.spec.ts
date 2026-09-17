/**
 * 渠道端口默认值的回归护栏（#354）。
 *
 * 为什么值得为"几个数字"写测试：这些默认值在集中到 `channel-defaults.ts` 之前散落在各适配器里，
 * 现在集中了、也就**更容易被顺手改掉**——而改端口默认值是**行为变更**（用户配置、部署脚本、
 * 反向代理都可能已按旧值固化），不是重构。这组断言把"当前默认值是多少"钉住：
 * 谁要改，就得先改这里，并同时在 PR 里说明迁移方式。
 *
 * 同时也固定住"渠道确实从这张表取默认值"这一事实的可观测来源——各渠道构造时的取值路径
 * （显式 options → 专用环境变量 → 本表）由 `tests/adapters/wecom-callback-contract.spec.ts` 等
 * 既有契约测试覆盖（那里的 `port: 0` 兜底语义即依赖 `wecomCallback` 的值）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_DEFAULT_PORTS } from "../../src/adapters/channel/protocol/channel-defaults.js";

test("渠道默认端口保持既有取值（改动属行为变更，须走迁移说明）", () => {
  assert.deepEqual(CHANNEL_DEFAULT_PORTS, {
    apiServer: 8642,
    webhook: 8643,
    wecomCallback: 8780,
    sms: 8790,
  });
});

test("渠道默认端口互不重复（端口冲突排查的前提）", () => {
  const ports = Object.values(CHANNEL_DEFAULT_PORTS);
  assert.equal(new Set(ports).size, ports.length, `默认端口出现重复：${ports.join(", ")}`);
  for (const port of ports) {
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `端口取值非法：${port}`);
  }
});

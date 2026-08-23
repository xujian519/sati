import test from "node:test";
import assert from "node:assert/strict";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { PrepareWeixinLoginResult } from "../../src/gateway/protocol/types.js";

// 行为面：InProcessGateway 委托注入的 prepareWeixinLogin 回调（透传），并在未注入时
// 降级 unsupported。仅做真实行为断言，不扫描源码字符串（历史伪测试已移除）。
test("Gateway protocol exposes prepare_weixin_login RPC", async () => {
  const expected: PrepareWeixinLoginResult = {
    requested: true,
    requestedAt: "2026-08-16T00:00:00.000Z",
  };
  const gateway = new InProcessGateway({} as SessionRouter, {
    prepareWeixinLogin: async () => expected,
  });
  assert.deepEqual(await gateway.prepareWeixinLogin(), expected);

  // 未注入时降级 unsupported（fail-open）
  const bare = new InProcessGateway({} as SessionRouter, {});
  const fallback = await bare.prepareWeixinLogin();
  assert.equal(fallback.requested, false);
  assert.equal(fallback.reason, "unsupported");
});

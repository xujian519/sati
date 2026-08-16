import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import type { PrepareWeixinLoginResult } from "../../src/gateway/protocol/types.js";

test("UI weixin QR route only reads runtime status", () => {
  const source = readFileSync(join(process.cwd(), "ui/server/routes/gateway.js"), "utf8");
  // Quote-style agnostic: the formatter may render these routes with single or double quotes.
  const routeStart = source.search(/router\.get\(["']\/weixin\/qr["']/);
  const routeEnd = source.search(/router\.post\(["']\/weixin\/disable["']/);

  assert.ok(routeStart >= 0, "expected /weixin/qr route to exist");
  assert.ok(routeEnd > routeStart, "expected weixin route section to be bounded");

  const weixinRouteSection = source.slice(routeStart, routeEnd);
  assert.doesNotMatch(weixinRouteSection, /loginWithQR/);
  assert.doesNotMatch(weixinRouteSection, /weixin-ilink/);
  assert.doesNotMatch(weixinRouteSection, /_weixinLogin/);
  assert.match(weixinRouteSection, /runtime\?\.state === ["']waiting_for_login["'] && runtime\.qrUrl/);
});

test("UI weixin QR begin route delegates to gateway prepare RPC", () => {
  const source = readFileSync(join(process.cwd(), "ui/server/routes/gateway.js"), "utf8");
  // Quote-style agnostic: the formatter may render these routes with single or double quotes.
  const routeStart = source.search(/router\.post\(["']\/weixin\/qr-begin["']/);
  const routeEnd = source.search(/router\.get\(["']\/weixin\/qr["']/);

  assert.ok(routeStart >= 0, "expected /weixin/qr-begin route to exist");
  assert.ok(routeEnd > routeStart, "expected begin route to be before read-only QR route");

  const beginRouteSection = source.slice(routeStart, routeEnd);
  assert.match(beginRouteSection, /config\.adapters\.weixin = \{ \.\.\.previous, enabled: true \}/);
  assert.match(beginRouteSection, /gw\.prepareWeixinLogin/);
  assert.match(beginRouteSection, /requestedAt/);
  assert.doesNotMatch(beginRouteSection, /loginWithQR/);
  assert.doesNotMatch(beginRouteSection, /weixin-ilink/);
  assert.doesNotMatch(beginRouteSection, /_weixinLogin/);
});

test("Gateway settings keeps existing status rendered during silent refresh", () => {
  const source = readFileSync(
    join(process.cwd(), "ui/src/components/settings/view/integrations/im/hooks/useGatewayStatus.ts"),
    "utf8",
  );

  assert.match(source, /if \(showLoading\) setLoading\(true\)/);
  assert.match(source, /void fetchStatus\(\{ showLoading: true \}\)/);
  assert.match(source, /setInterval\(\(\) => \{\s*void fetchStatus\(\);/s);
});

test("Gateway settings starts weixin QR by begin route and ignores stale runtime errors", () => {
  const source = readFileSync(
    join(process.cwd(), "ui/src/components/settings/view/integrations/im/components/WeixinChannelSection.tsx"),
    "utf8",
  );

  assert.match(source, /authenticatedFetch\("\/api\/gateway\/weixin\/qr-begin", \{\s*method: "POST",?\s*\}\)/);
  assert.doesNotMatch(source, /authenticatedFetch\("\/api\/gateway\/weixin\/qr"\)/);
  assert.match(source, /requestedAtRef/);
  assert.match(source, /isRuntimeCurrent/);
  assert.match(source, /WEIXIN_QR_PREPARE_TIMEOUT_MS/);
});

test("Gateway protocol exposes prepare_weixin_login RPC", async () => {
  // 协议面（帧形状 / WS 分发 / 客户端方法）——这些文件不参与 InProcessGateway
  // 拆解，轻量源码断言保持稳定。
  const frames = readFileSync(join(process.cwd(), "src/gateway/protocol/frames.ts"), "utf8");
  const wsConnection = readFileSync(join(process.cwd(), "src/gateway/server/GatewayWsConnection.ts"), "utf8");
  const remoteGateway = readFileSync(join(process.cwd(), "src/gateway/client/RemoteGateway.ts"), "utf8");

  assert.match(frames, /"prepare_weixin_login"/);
  assert.match(wsConnection, /case "prepare_weixin_login"/);
  assert.match(remoteGateway, /request\("prepare_weixin_login", \{\}\)/);

  // 行为面：InProcessGateway 委托注入的 prepareWeixinLogin 回调（透传）——
  // 不再扫描 InProcessGateway.ts 源码字符串（拆解移动方法即碎）。
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

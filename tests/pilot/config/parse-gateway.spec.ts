import test from "node:test";
import assert from "node:assert/strict";
import { parseGatewayConfig, parseAdaptersConfig } from "../../../src/pilot/config/parseGatewayConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

function diag(): PilotConfigDiagnostic[] {
  return [];
}

test("parseGatewayConfig returns undefined when absent", () => {
  assert.equal(parseGatewayConfig(undefined, diag()), undefined);
});

test("parseGatewayConfig flags non-object input as fatal", () => {
  const diagnostics = diag();
  assert.equal(parseGatewayConfig("x", diagnostics), undefined);
  assert.equal(diagnostics[0]?.code, "GATEWAY_CONFIG_INVALID");
  assert.equal(diagnostics[0]?.severity, "fatal");
});

test("parseGatewayConfig applies defaults", () => {
  const config = parseGatewayConfig({}, diag())!;
  assert.equal(config.port, 19789);
  assert.equal(config.bindAddress, "127.0.0.1");
  assert.equal(config.idleSessionTimeoutMinutes, 30);
  assert.equal(config.idleSweepIntervalSeconds, 60);
  assert.equal(config.memoryDiagnostics, false);
  assert.equal(config.maxPerSessionMcpInstances, 5);
});

test("parseGatewayConfig honors provided fields and coerces types", () => {
  const config = parseGatewayConfig(
    {
      port: "8080", // non-number -> fallback
      idleSessionTimeoutMinutes: 15,
      memoryDiagnostics: true,
      staticAssetsPath: "/srv/assets",
      maxPerSessionMcpInstances: 0, // clamped to 1
    },
    diag(),
  )!;
  assert.equal(config.port, 19789);
  assert.equal(config.idleSessionTimeoutMinutes, 15);
  assert.equal(config.memoryDiagnostics, true);
  assert.equal(config.staticAssetsPath, "/srv/assets");
  assert.equal(config.maxPerSessionMcpInstances, 1);
});

test("parseGatewayConfig rejects non-loopback bindAddress as fatal", () => {
  const diagnostics = diag();
  const config = parseGatewayConfig({ bindAddress: "0.0.0.0" }, diagnostics)!;
  assert.equal(config.bindAddress, "127.0.0.1");
  assert.equal(diagnostics[0]?.code, "GATEWAY_BIND_ADDRESS_UNSUPPORTED");
  assert.equal(diagnostics[0]?.severity, "fatal");
});

test("parseGatewayConfig warns about removed tokenPath", () => {
  const diagnostics = diag();
  parseGatewayConfig({ tokenPath: "/tmp/token" }, diagnostics);
  assert.equal(diagnostics[0]?.code, "GATEWAY_TOKEN_PATH_REMOVED");
  assert.equal(diagnostics[0]?.severity, "warning");
});

test("parseAdaptersConfig returns undefined when absent", () => {
  assert.equal(parseAdaptersConfig(undefined, diag()), undefined);
});

test("parseAdaptersConfig flags non-object input as fatal", () => {
  const diagnostics = diag();
  assert.equal(parseAdaptersConfig(42, diagnostics), undefined);
  assert.equal(diagnostics[0]?.code, "ADAPTERS_CONFIG_INVALID");
});

test("parseAdaptersConfig parses cli/tui auto-connect when present", () => {
  const absent = parseAdaptersConfig({}, diag())!;
  assert.equal(absent.cli, undefined);
  assert.equal(absent.tui, undefined);
  const config = parseAdaptersConfig({ cli: {}, tui: { autoConnectServer: false } }, diag())!;
  assert.deepEqual(config.cli, { autoConnectServer: true });
  assert.deepEqual(config.tui, { autoConnectServer: false });
});

test("parseAdaptersConfig parses feishu-specific fields and connection mode", () => {
  const config = parseAdaptersConfig(
    {
      feishu: {
        enabled: true,
        appId: "app",
        appSecret: "sec",
        encryptKey: "enc",
        verifyToken: "vt",
        connectionMode: "stream",
        domainName: "feishu",
        defaultSessionLabel: "patent",
      },
    },
    diag(),
  )!;
  assert.equal(config.feishu?.enabled, true);
  assert.equal(config.feishu?.appId, "app");
  assert.equal(config.feishu?.connectionMode, "stream");
  assert.equal(config.feishu?.domainName, "feishu");
  assert.equal(config.feishu?.defaultSessionLabel, "patent");
});

test("parseAdaptersConfig rejects invalid feishu enums", () => {
  const config = parseAdaptersConfig({ feishu: { connectionMode: "grpc", domainName: "example.com" } }, diag())!;
  assert.equal(config.feishu?.connectionMode, undefined);
  assert.equal(config.feishu?.domainName, undefined);
});

test("parseAdaptersConfig parses qq-specific fields with string filters", () => {
  const config = parseAdaptersConfig(
    {
      qq: {
        enabled: true,
        appId: "qq-app",
        clientSecret: "cs",
        allowGroups: ["g1", 5, "g2"],
        triggerPrefixes: ["!", 7],
        maxMessageLength: 2000,
      },
    },
    diag(),
  )!;
  assert.equal(config.qq?.enabled, true);
  assert.deepEqual(config.qq?.allowGroups, ["g1", "g2"]);
  assert.deepEqual(config.qq?.triggerPrefixes, ["!"]);
  assert.equal(config.qq?.maxMessageLength, 2000);
});

test("parseAdaptersConfig parses the 16 platform adapters generically", () => {
  const config = parseAdaptersConfig(
    {
      telegram: { enabled: true, token: "t1" },
      discord: { apiKey: "k" },
      slack: { webhookUrl: "w" },
      matrix: { enabled: false },
      mattermost: { extra: { server: "x" } },
      signal: {},
      whatsapp: { token: "w2" },
      bluebubbles: { apiKey: "b" },
      dingtalk: { token: "d" },
      wecom: { enabled: true },
      wecomCallback: { enabled: true },
      email: {},
      sms: { apiKey: "s" },
      homeassistant: { token: "h" },
      apiServer: { enabled: true },
      webhook: { enabled: true },
    },
    diag(),
  )!;
  assert.equal(config.telegram?.token, "t1");
  assert.equal(config.discord?.apiKey, "k");
  assert.equal(config.slack?.webhookUrl, "w");
  assert.equal(config.matrix?.enabled, false);
  assert.deepEqual(config.mattermost?.extra, { server: "x" });
  assert.equal(config.wecom?.enabled, true);
  assert.equal(config.wecomCallback?.enabled, true);
  assert.equal(config.apiServer?.enabled, true);
  assert.equal(config.webhook?.enabled, true);
});

test("parseAdaptersConfig parses weixin as enabled-only", () => {
  const config = parseAdaptersConfig({ weixin: { enabled: true, token: "ignored" } }, diag())!;
  assert.deepEqual(config.weixin, { enabled: true });
});

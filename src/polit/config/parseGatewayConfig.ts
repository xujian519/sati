import { isRecord } from "../../model/config/schema.js";
import type { PolitAdaptersConfig, PolitConfigDiagnostic, PolitGatewayConfig } from "./types.js";

export function parseGatewayConfig(rawGateway: unknown, diagnostics: PolitConfigDiagnostic[]): PolitGatewayConfig | undefined {
  if (rawGateway === undefined) {
    return undefined;
  }
  if (!isRecord(rawGateway)) {
    diagnostics.push({
      code: "GATEWAY_CONFIG_INVALID",
      severity: "fatal",
      message: "gateway config must be an object.",
      path: "gateway",
      recoverable: false,
    });
    return undefined;
  }

  const bindAddress = stringField(rawGateway, "bindAddress", "127.0.0.1");
  if (bindAddress !== "127.0.0.1") {
    diagnostics.push({
      code: "GATEWAY_BIND_ADDRESS_UNSUPPORTED",
      severity: "fatal",
      message: "gateway.bindAddress must be 127.0.0.1 in the first phase.",
      path: "gateway.bindAddress",
      recoverable: false,
    });
  }
  if (rawGateway.tokenPath !== undefined) {
    diagnostics.push({
      code: "GATEWAY_TOKEN_PATH_REMOVED",
      severity: "warning",
      message: "gateway.tokenPath is no longer configurable; the gateway token is stored under PolitHome.",
      path: "gateway.tokenPath",
      recoverable: true,
    });
  }

  return {
    port: numberField(rawGateway, "port", 18789),
    bindAddress: "127.0.0.1",
    idleSessionTimeoutMinutes: numberField(rawGateway, "idleSessionTimeoutMinutes", 30),
    staticAssetsPath: stringField(rawGateway, "staticAssetsPath"),
  };
}

export function parseAdaptersConfig(rawAdapters: unknown, diagnostics: PolitConfigDiagnostic[]): PolitAdaptersConfig | undefined {
  if (rawAdapters === undefined) {
    return undefined;
  }
  if (!isRecord(rawAdapters)) {
    diagnostics.push({
      code: "ADAPTERS_CONFIG_INVALID",
      severity: "fatal",
      message: "adapters config must be an object.",
      path: "adapters",
      recoverable: false,
    });
    return undefined;
  }

  return {
    cli: parseAutoConnect(rawAdapters.cli),
    tui: parseAutoConnect(rawAdapters.tui),
    feishu: parseFeishu(rawAdapters.feishu),
  };
}

function parseAutoConnect(raw: unknown): { autoConnectServer: boolean } | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return { autoConnectServer: booleanField(raw, "autoConnectServer", true) };
}

function parseFeishu(raw: unknown): PolitAdaptersConfig["feishu"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    enabled: booleanField(raw, "enabled", false),
    appId: stringField(raw, "appId"),
    appSecret: stringField(raw, "appSecret"),
    encryptKey: stringField(raw, "encryptKey"),
    verifyToken: stringField(raw, "verifyToken"),
    defaultSessionLabel: stringField(raw, "defaultSessionLabel", "general") ?? "general",
  };
}

function stringField(record: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : fallback;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : fallback;
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof record[key] === "boolean" ? record[key] : fallback;
}

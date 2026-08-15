import assert from "node:assert/strict";
import test from "node:test";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { buildProviderHeaders } from "../../../src/model/streaming/streamModel.js";
import { redactConfig } from "../../../src/pilot/config/redact.js";
import { ModelRequestError } from "../../../src/model/protocol/errors.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../src/model/protocol/capabilities.js";
import type { ProviderConfig } from "../../../src/model/protocol/canonical.js";

/**
 * credentials 引用/值分离测试（T4）。
 *
 * 核心语义（对应 dsh CredentialRef）：
 * - 配置保存原始引用（apiKeyRaw + apiKeySource），parse 时求值一次（apiKey）；
 * - env 引用在请求期惰性重解析（buildProviderHeaders）——密钥轮换下一次
 *   请求即生效，无需重启；
 * - 任何 describe / 诊断 / 配置序列化不暴露解析后明文（redact）。
 */

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "openai",
    protocol: "openai",
    url: "https://api.openai.test/v1",
    apiKey: "sk-literal-1234567890",
    headers: {},
    models: {
      "gpt-test": {
        id: "gpt-test",
        capabilities: DEFAULT_MODEL_CAPABILITIES,
        multimodal: { input: ["text"] },
      },
    },
    ...overrides,
  };
}

/** HeadersInit 可能是 Headers 实例；访问用 Record 视图。 */
function headerValue(headers: HeadersInit, key: string): string | undefined {
  const record = headers as Record<string, string>;
  return record[key];
}

test("parseModelConfig：字面量 apiKey 记录 literal 源与原始值", () => {
  const config = parseModelConfig({
    providers: {
      openai: {
        url: "https://api.openai.test/v1",
        apiKey: " sk-literal-1234567890 ",
        models: { "gpt-test": {} },
      },
    },
  });
  const provider = config.providers.openai;
  assert.equal(provider.apiKey, "sk-literal-1234567890");
  assert.equal(provider.apiKeySource, "literal");
  assert.equal(provider.apiKeyRaw, "sk-literal-1234567890");
});

test("parseModelConfig：${VAR} 引用记录 env 源并 parse 期求值", () => {
  const config = parseModelConfig(
    {
      providers: {
        openai: {
          url: "https://api.openai.test/v1",
          apiKey: "${MY_OPENAI_KEY}",
          models: { "gpt-test": {} },
        },
      },
    },
    { env: { MY_OPENAI_KEY: " sk-env-v1 " } },
  );
  const provider = config.providers.openai;
  assert.equal(provider.apiKey, "sk-env-v1");
  assert.equal(provider.apiKeySource, "env");
  assert.equal(provider.apiKeyRaw, "${MY_OPENAI_KEY}");
});

test("catalog 兜底 env 引用同样记录 env 源（apiKey 省略）", () => {
  const config = parseModelConfig(
    {
      providers: {
        openai: {
          models: { "gpt-4o-mini": {} },
        },
      },
    },
    { env: { OPENAI_API_KEY: " sk-env " } },
  );
  const provider = config.providers.openai;
  assert.equal(provider.apiKey, "sk-env");
  assert.equal(provider.apiKeySource, "env");
  assert.equal(provider.apiKeyRaw, "${OPENAI_API_KEY}");
});

test("buildProviderHeaders：env 源轮换环境变量后下一次请求用新值（无需重启）", () => {
  const provider = makeProvider({
    apiKey: "sk-env-v1",
    apiKeyRaw: "${ROTATING_KEY}",
    apiKeySource: "env",
  });
  const env1 = { ROTATING_KEY: "sk-env-v1" };
  const headers1 = buildProviderHeaders(provider, env1);
  assert.match(headerValue(headers1, "authorization") ?? "", /Bearer sk-env-v1/);

  // 轮换：不重启进程，仅改环境变量。
  const env2 = { ROTATING_KEY: "sk-env-v2-rotated" };
  const headers2 = buildProviderHeaders(provider, env2);
  assert.match(headerValue(headers2, "authorization") ?? "", /Bearer sk-env-v2-rotated/);
});

test("buildProviderHeaders：anthropic 协议走 x-api-key 头（env 源同样惰性解析）", () => {
  const provider = makeProvider({
    protocol: "anthropic",
    url: "https://api.anthropic.test",
    apiKey: "sk-ant-v1",
    apiKeyRaw: "${ANTHROPIC_KEY}",
    apiKeySource: "env",
  });
  const headers = buildProviderHeaders(provider, { ANTHROPIC_KEY: "sk-ant-rotated" });
  assert.equal(headerValue(headers, "x-api-key"), "sk-ant-rotated");
});

test("buildProviderHeaders：literal 源用 parse 期已解析值，不受 env 变化影响", () => {
  const provider = makeProvider({ apiKey: "sk-literal-1234567890", apiKeySource: "literal" });
  const headers = buildProviderHeaders(provider, {});
  assert.match(headerValue(headers, "authorization") ?? "", /Bearer sk-literal-1234567890/);
});

test("buildProviderHeaders：env 引用解析失败抛错（fail-loud，不静默用旧值）", () => {
  const provider = makeProvider({
    apiKey: "sk-env-v1",
    apiKeyRaw: "${DELETED_KEY}",
    apiKeySource: "env",
  });
  assert.throws(
    () => buildProviderHeaders(provider, {}),
    // 阶段四 T10：请求路径把凭证 seam 的稳定双码转成 ModelRequestError，
    // 使 router 可将其原样带入 CanonicalModelError.code（fail-loud 语义不变）。
    (error: unknown) => error instanceof ModelRequestError && error.code === "missing_credential",
  );
});

test("redactConfig：apiKeyRaw / apiKeySource 字段同样脱敏（不泄漏明文）", () => {
  const redacted = redactConfig({
    model: {
      providers: {
        openai: {
          url: "https://api.openai.test",
          apiKey: "sk-literal-1234567890",
          apiKeyRaw: "sk-literal-1234567890",
          apiKeySource: "literal",
        },
      },
    },
  });
  const provider = (redacted as { model: { providers: Record<string, Record<string, unknown>> } }).model.providers
    .openai;
  assert.equal(provider.apiKey, "<redacted>");
  assert.equal(provider.apiKeyRaw, "<redacted>");
  assert.equal(provider.apiKeySource, "literal"); // 非敏感字段保留
  assert.equal(provider.url, "https://api.openai.test");
});

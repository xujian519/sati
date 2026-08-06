import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import type { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import type { KnowledgeCapabilitiesInput, KnowledgeCapabilitiesResult } from "../../src/gateway/protocol/types.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

function makeResult(overrides: Partial<KnowledgeCapabilitiesResult> = {}): KnowledgeCapabilitiesResult {
  return {
    dataDir: "/tmp/sati-knowledge-test",
    capabilities: [
      { id: "patent-kg", label: "专利知识图谱", status: "ready" },
      { id: "kg-fts-tokenizer", label: "KG FTS 分词器", status: "ready", detail: "trigram" },
    ],
    embeddingConfigured: true,
    rerankConfigured: false,
    ...overrides,
  };
}

function makeGateway(
  handler?: (input: KnowledgeCapabilitiesInput) => Promise<KnowledgeCapabilitiesResult>,
): InProcessGateway {
  return new InProcessGateway({} as SessionRouter, { knowledgeCapabilities: handler });
}

describe("InProcessGateway knowledgeCapabilities", () => {
  it("注入 handler 时透传 projectKey 并返回其结果", async () => {
    const seen: KnowledgeCapabilitiesInput[] = [];
    const gateway = makeGateway(async input => {
      seen.push(input);
      return makeResult();
    });
    const result = await gateway.knowledgeCapabilities({ projectKey: "/proj" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.projectKey, "/proj");
    assert.equal(result.dataDir, "/tmp/sati-knowledge-test");
    assert.equal(result.capabilities.length, 2);
    assert.equal(result.embeddingConfigured, true);
    assert.equal(result.error, undefined);
  });

  it("未注入 handler 时返回 not_configured 结果而非抛错", async () => {
    const gateway = makeGateway(undefined);
    const result = await gateway.knowledgeCapabilities({});
    assert.equal(result.error?.code, "not_configured");
    assert.equal(result.dataDir, "");
    assert.deepEqual(result.capabilities, []);
    assert.equal(result.embeddingConfigured, false);
    assert.equal(result.rerankConfigured, false);
  });
});

describe("RemoteGateway knowledgeCapabilities 请求封装", () => {
  function makeRemote(record: { method: string; params: unknown }): RemoteGateway {
    const client = {
      request: async (method: string, params: unknown) => {
        record.method = method;
        record.params = params;
        return makeResult();
      },
    } as unknown as GatewayWsClient;
    return new RemoteGateway(client);
  }

  it("走 knowledge_capabilities 方法并透传参数", async () => {
    const record = { method: "", params: undefined };
    const remote = makeRemote(record);
    const input: KnowledgeCapabilitiesInput = { projectKey: "/proj" };
    const result = await remote.knowledgeCapabilities(input);
    assert.equal(record.method, "knowledge_capabilities");
    assert.deepEqual(record.params, input);
    assert.equal(result.dataDir, "/tmp/sati-knowledge-test");
  });
});

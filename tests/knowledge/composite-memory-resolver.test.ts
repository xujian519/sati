import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  MemoryCaptureTurnInput,
  MemoryResolver,
  MemoryRetrieveInput,
} from "../../src/context/memory/MemoryResolver.js";
import { CompositeMemoryResolver } from "../../src/knowledge/shared/composite-memory-resolver.js";

function makeInput(overrides: Partial<MemoryRetrieveInput> = {}): MemoryRetrieveInput {
  return {
    query: "专利",
    sessionId: "s1",
    projectRoot: "/tmp",
    recentMessages: [],
    ...overrides,
  };
}

function makeCaptureInput(): MemoryCaptureTurnInput {
  return { sessionId: "s1", projectRoot: "/tmp", messages: [], errored: false };
}

function stubResolver(name: string, context?: string): MemoryResolver {
  return {
    retrieve: async (input: MemoryRetrieveInput) => ({
      systemContext: context ?? `<block>${name}:${input.query}</block>`,
      diagnostics: [],
    }),
    captureTurn: async () => {},
  };
}

describe("composite-memory-resolver", () => {
  it("拼接多个 resolver 的 systemContext", async () => {
    const composite = new CompositeMemoryResolver([
      stubResolver("a", "<block-a>1</block-a>"),
      stubResolver("b", "<block-b>2</block-b>"),
    ]);
    const result = await composite.retrieve(makeInput());
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.includes("<block-a>1</block-a>"));
    assert.ok(result.systemContext.includes("<block-b>2</block-b>"));
  });

  it("空 context 的 resolver 被跳过", async () => {
    const emptyResolver: MemoryResolver = {
      retrieve: async () => ({ systemContext: undefined, diagnostics: [] }),
      captureTurn: async () => {},
    };
    const composite = new CompositeMemoryResolver([stubResolver("a", "<block-a>1</block-a>"), emptyResolver]);
    const result = await composite.retrieve(makeInput());
    assert.ok(result.systemContext);
    assert.ok(!result.systemContext.includes("undefined"));
  });

  it("单个 resolver 失败不阻断其他", async () => {
    const failing: MemoryResolver = {
      retrieve: async () => {
        throw new Error("boom");
      },
      captureTurn: async () => {},
    };
    const composite = new CompositeMemoryResolver([failing, stubResolver("a", "<block-a>1</block-a>")]);
    const result = await composite.retrieve(makeInput());
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.includes("<block-a>1</block-a>"));
    assert.ok(result.diagnostics.some(d => d.severity === "warning"));
  });

  it("全部失败时 systemContext 为 undefined", async () => {
    const failing: MemoryResolver = {
      retrieve: async () => {
        throw new Error("boom");
      },
      captureTurn: async () => {},
    };
    const composite = new CompositeMemoryResolver([failing]);
    const result = await composite.retrieve(makeInput());
    assert.equal(result.systemContext, undefined);
  });

  it("captureTurn 广播到所有 resolver", async () => {
    let captured = 0;
    const resolver: MemoryResolver = {
      retrieve: async () => ({ systemContext: undefined, diagnostics: [] }),
      captureTurn: async () => {
        captured += 1;
      },
    };
    const composite = new CompositeMemoryResolver([resolver, resolver]);
    await composite.captureTurn(makeCaptureInput());
    assert.equal(captured, 2);
  });

  it("captureTurn 单个失败不抛出", async () => {
    const failing: MemoryResolver = {
      retrieve: async () => ({ systemContext: undefined, diagnostics: [] }),
      captureTurn: async () => {
        throw new Error("boom");
      },
    };
    const composite = new CompositeMemoryResolver([failing, stubResolver("a")]);
    await composite.captureTurn(makeCaptureInput());
  });
});

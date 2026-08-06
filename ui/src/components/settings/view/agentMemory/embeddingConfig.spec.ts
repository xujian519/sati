import { describe, expect, it } from "vitest";
import { compactEmbedding, compactRerank } from "./embeddingConfig";

describe("compactRerank", () => {
  it("空块返回 undefined", () => {
    expect(compactRerank(undefined)).toBeUndefined();
    expect(compactRerank({})).toBeUndefined();
  });

  it("仅 enabled:false 的块丢弃（不残留墓碑）", () => {
    expect(compactRerank({ enabled: false })).toBeUndefined();
  });

  it("仅 enabled:true 保留", () => {
    expect(compactRerank({ enabled: true })).toEqual({ enabled: true });
  });

  it("enabled:false 但带自定义字段时保留（关闭后重开不丢配置）", () => {
    expect(compactRerank({ enabled: false, baseUrl: "http://x" })).toEqual({ enabled: false, baseUrl: "http://x" });
  });

  it("字符串字段 trim 后为空则丢弃", () => {
    expect(compactRerank({ enabled: true, baseUrl: "   " })).toEqual({ enabled: true });
  });

  it("字符串字段 trim 后保留", () => {
    expect(compactRerank({ enabled: true, baseUrl: "  http://x  " })).toEqual({ enabled: true, baseUrl: "http://x" });
  });

  it("数值字段原样透传（含 0）", () => {
    expect(compactRerank({ enabled: true, topN: 16, timeoutMs: 0 })).toEqual({ enabled: true, topN: 16, timeoutMs: 0 });
  });
});

describe("compactEmbedding", () => {
  it("空块返回 undefined", () => {
    expect(compactEmbedding(undefined)).toBeUndefined();
    expect(compactEmbedding({})).toBeUndefined();
  });

  it("仅 enabled:false 的块丢弃（与 rerank 同策略）", () => {
    expect(compactEmbedding({ enabled: false })).toBeUndefined();
  });

  it("enabled:false 带自定义字段时保留", () => {
    expect(compactEmbedding({ enabled: false, model: "bge-m3" })).toEqual({ enabled: false, model: "bge-m3" });
  });

  it("空字符串字段不写入", () => {
    expect(compactEmbedding({ enabled: true, baseUrl: "", apiKey: "  " })).toEqual({ enabled: true });
  });

  it("rerank 嵌套压缩：仅 enabled:false 的 rerank 块被移除", () => {
    expect(compactEmbedding({ enabled: true, rerank: { enabled: false } })).toEqual({ enabled: true });
    expect(compactEmbedding({ enabled: true, rerank: { enabled: true, topN: 8 } })).toEqual({
      enabled: true,
      rerank: { enabled: true, topN: 8 },
    });
  });

  it("indexWiki/indexMemory 布尔透传", () => {
    expect(compactEmbedding({ enabled: true, indexWiki: false })).toEqual({ enabled: true, indexWiki: false });
    expect(compactEmbedding({ enabled: true, indexMemory: false })).toEqual({ enabled: true, indexMemory: false });
  });
});

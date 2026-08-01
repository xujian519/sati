import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  chunkText,
  insertVectorChunk,
  openVectorsDbWriter,
  quantizeInt8,
  setCorpusMeta,
} from "../../src/knowledge/shared/vector-db-writer.js";
import { VectorDbSearch } from "../../src/knowledge/shared/vector-db.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-vdb-"));
}

describe("chunkText", () => {
  it("短文本不分块", () => {
    assert.deepEqual(chunkText("短文本", 1200, 200), ["短文本"]);
  });

  it("空文本/纯空白返回空数组", () => {
    assert.deepEqual(chunkText(""), []);
    assert.deepEqual(chunkText("   "), []);
  });

  it("长文本按 chunkChars 分块且相邻块重叠 overlap", () => {
    const text = "创".repeat(100);
    const chunks = chunkText(text, 50, 10);
    // 步长 = 50-10 = 40：chunk0=[0,50) chunk1=[40,90) chunk2=[80,100)
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]!.length, 50);
    assert.equal(chunks[1]!.length, 50);
    assert.equal(chunks[2]!.length, 20);
    // 重叠：后一块头部包含前一块尾部
    assert.ok(chunks[1]!.startsWith(chunks[0]!.slice(-10)));
  });

  it("按码点切分不产生孤立代理对", () => {
    const text = "😀".repeat(10); // 10 个码点（每个 2 个 UTF-16 码元）
    const chunks = chunkText(text, 3, 1);
    assert.equal(chunks.length, 5);
    const hasLoneSurrogate = (s: string): boolean => {
      for (let i = 0; i < s.length; i += 1) {
        const code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (next < 0xdc00 || next > 0xdfff) return true;
          i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return true;
        }
      }
      return false;
    };
    for (const chunk of chunks) {
      assert.equal(hasLoneSurrogate(chunk), false);
    }
  });
});

describe("quantizeInt8", () => {
  it("scale = maxAbs/127，量化后裁剪到 [-127,127]", () => {
    const { values, scale } = quantizeInt8(Float32Array.from([1, 0.5, -0.25, 0]));
    assert.ok(Math.abs(scale - 1 / 127) < 1e-9);
    assert.equal(values[0], 127);
    assert.equal(values[1], 64); // 0.5/scale = 63.5 → 四舍五入 64
    assert.equal(values[2], -32);
    assert.equal(values[3], 0);
  });

  it("零向量返回全 0 与 scale=1", () => {
    const { values, scale } = quantizeInt8(new Float32Array(3));
    assert.equal(scale, 1);
    assert.deepEqual(Array.from(values), [0, 0, 0]);
  });

  it("量化后的余弦与 float 余弦近似一致（scale 抵消）", () => {
    const a = Float32Array.from([1, 2, 3, 4]);
    const b = Float32Array.from([4, 3, 2, 1]);
    const qa = quantizeInt8(a).values;
    const qb = quantizeInt8(b).values;
    const dot = (x: ArrayLike<number>, y: ArrayLike<number>): number => {
      let s = 0;
      for (let i = 0; i < x.length; i += 1) s += x[i]! * y[i]!;
      return s;
    };
    const norm = (x: ArrayLike<number>): number => Math.sqrt(dot(x, x));
    const floatCos = dot(a, b) / (norm(a) * norm(b));
    const int8Cos = dot(qa, qb) / (norm(qa) * norm(qb));
    assert.ok(Math.abs(floatCos - int8Cos) < 0.01);
  });
});

describe("VectorDbSearch", () => {
  it("写入后可检索：top-k 排序正确", () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "vectors.db");
      const db = openVectorsDbWriter(path);
      setCorpusMeta(db, {
        corpus: "kg",
        dimensions: 4,
        model: "test",
        chunkChars: 1200,
        chunkOverlap: 200,
        builtAt: "t",
      });
      const put = (docId: string, vector: number[]): void => {
        const { values, scale } = quantizeInt8(Float32Array.from(vector));
        insertVectorChunk(db, "kg", docId, 0, values, "h", scale);
      };
      put("doc-a", [1, 0, 0, 0]);
      put("doc-b", [0, 1, 0, 0]);
      put("doc-c", [1, 1, 0, 0]);
      db.close();

      const vdb = new VectorDbSearch({ dbPath: path });
      assert.equal(vdb.hasCorpus("kg"), true);
      assert.equal(vdb.hasCorpus("law"), false);
      assert.equal(vdb.dimensionsOf("kg"), 4);

      const hits = vdb.search("kg", Float32Array.from([1, 0, 0, 0]), 2);
      assert.equal(hits.length, 2);
      assert.equal(hits[0]!.docId, "doc-a");
      assert.ok(hits[0]!.score > hits[1]!.score);
      vdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("多 chunk 文档得分取最高 chunk 余弦", () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "vectors.db");
      const db = openVectorsDbWriter(path);
      setCorpusMeta(db, {
        corpus: "law",
        dimensions: 3,
        model: "test",
        chunkChars: 1200,
        chunkOverlap: 200,
        builtAt: "t",
      });
      const put = (docId: string, chunkIndex: number, vector: number[]): void => {
        const { values, scale } = quantizeInt8(Float32Array.from(vector));
        insertVectorChunk(db, "law", docId, chunkIndex, values, "h", scale);
      };
      // doc-x chunk0 与查询正交，chunk1 高度相关 → doc 得分应接近 chunk1
      put("doc-x", 0, [1, 0, 0]);
      put("doc-x", 1, [0, 1, 0]);
      put("doc-y", 0, [1, 1, 0]);
      db.close();

      const vdb = new VectorDbSearch({ dbPath: path });
      const hits = vdb.search("law", Float32Array.from([0, 1, 0]), 2);
      assert.equal(hits[0]!.docId, "doc-x"); // doc-x 的 chunk1 完美匹配
      assert.ok(hits[0]!.score > 0.99);
      vdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未索引语料/空语料返回空数组", () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "vectors.db");
      const db = openVectorsDbWriter(path);
      setCorpusMeta(db, {
        corpus: "kg",
        dimensions: 4,
        model: "test",
        chunkChars: 1200,
        chunkOverlap: 200,
        builtAt: "t",
      });
      db.close();

      const vdb = new VectorDbSearch({ dbPath: path });
      assert.deepEqual(vdb.search("kg", Float32Array.from([1, 0, 0, 0]), 3), []);
      assert.deepEqual(vdb.search("nope", Float32Array.from([1, 0, 0, 0]), 3), []);
      vdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

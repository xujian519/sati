import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyChunkMatrix,
  loadChunkMatrix,
  searchChunkMatrix,
  type ChunkPageSource,
  type Int8ChunkMatrix,
} from "../../src/knowledge/shared/int8-matrix-search.js";
import { int8Dot, l2Norm, quantizeInt8, topK } from "../../src/context/vector/cosine.js";

/**
 * int8-matrix-search 无损剪枝测试。
 *
 * 剪枝契约：searchChunkMatrix 的返回值必须与"无剪枝暴力参照"逐位一致
 * （docId 顺序 + score）——剪枝只跳过"上界 ≤ 当前 topK 阈值"的 chunk，
 * 不改变任何进入 topK 的候选。
 */

const DIM = 8;

/** 由向量数组（文档 → chunk 列表）构造内存矩阵。 */
function matrixFromDocs(docs: Array<{ id: string; vectors: number[][] }>): Int8ChunkMatrix {
  const entries: Array<{ document_id: string; chunk_id: number; vector: Uint8Array }> = [];
  let chunkId = 0;
  for (const doc of docs) {
    for (const v of doc.vectors) {
      const { values } = quantizeInt8(Float32Array.from(v));
      entries.push({ document_id: doc.id, chunk_id: chunkId, vector: new Uint8Array(values.buffer, 0, DIM) });
      chunkId += 1;
    }
  }
  const source: ChunkPageSource = {
    pageFirst: limit => entries.slice(0, limit),
    pageNext: (docId, chunkId0, limit) => {
      const start = entries.findIndex(e => e.document_id > docId || (e.document_id === docId && e.chunk_id > chunkId0));
      return start < 0 ? [] : entries.slice(start, start + limit);
    },
  };
  const decode = (raw: Uint8Array): Int8Array => {
    // int8 域（dim 字节）：直接读取。
    if (raw.byteLength === DIM) return new Int8Array(raw.buffer, raw.byteOffset, DIM);
    return new Int8Array(DIM);
  };
  return loadChunkMatrix(source, DIM, decode);
}

/** 无剪枝暴力参照：全部 chunk 点积 + 收集后 topK（与旧实现语义一致）。 */
function bruteForceSearch(data: Int8ChunkMatrix, queryVector: Float32Array, limit: number) {
  const query = quantizeInt8(queryVector).values;
  const queryNorm = l2Norm(query);
  if (queryNorm === 0) return [];
  const docScores = new Map<string, number>();
  for (const [docId, range] of data.docOffsets) {
    let best = -Infinity;
    for (let i = range.start; i < range.end; i += 1) {
      const norm = data.norms[i] ?? 0;
      if (norm === 0) continue;
      const score =
        int8Dot(query, data.vectors.subarray(i * data.dimensions, (i + 1) * data.dimensions)) / (queryNorm * norm);
      if (score > best) best = score;
    }
    if (best > -Infinity) docScores.set(docId, best);
  }
  const scores = Float32Array.from(docScores.values());
  const ids = Array.from(docScores.keys());
  return topK(scores, limit).map(hit => ({ docId: ids[hit.index]!, score: hit.score }));
}

/**
 * 剪枝与暴力对照断言：docId 顺序必须逐位一致；score 用容差比较——
 * V8 对不同代码形态（内联循环 vs int8Dot 函数）可能生成不同的 FMA/F32
 * 指令序列，浮点运算不保证逐位确定性（实测差异 ~1e-8 相对），数学等价
 * 且排序/归属一致即可（正常文档分差 ≥1e-3，1e-6 容差足够区分）。
 */
function assertSameResults(
  got: Array<{ docId: string; score: number }>,
  want: Array<{ docId: string; score: number }>,
  context: string,
): void {
  assert.deepEqual(
    got.map(h => h.docId),
    want.map(h => h.docId),
    `${context}：docId 顺序应与暴力一致（got=${JSON.stringify(got)} want=${JSON.stringify(want)}）`,
  );
  assert.equal(got.length, want.length, `${context}：结果数量应一致`);
  for (let i = 0; i < got.length; i += 1) {
    const g = got[i]!.score;
    const w = want[i]!.score;
    assert.ok(Math.abs(g - w) < 1e-6, `${context}：score 应一致（got=${g} want=${w}，差 ${Math.abs(g - w)}）`);
  }
}

/** 构造涵盖得分梯度/并列/零向量 chunk/多 chunk 文档的 fixture（候选远超 limit，确保剪枝路径触发）。 */
function buildFixture(): Int8ChunkMatrix {
  return matrixFromDocs([
    {
      id: "d1",
      vectors: [
        [1, 0, 0, 0, 0, 0, 0, 0],
        [0.95, 0.05, 0, 0, 0, 0, 0, 0],
        [0.5, 0.5, 0, 0, 0, 0, 0, 0],
      ],
    },
    {
      id: "d2",
      vectors: [
        [0, 1, 0, 0, 0, 0, 0, 0],
        [0.1, 0.9, 0, 0, 0, 0, 0, 0],
      ],
    },
    { id: "d3", vectors: [[0, 0, 1, 0, 0, 0, 0, 0]] },
    {
      id: "d4",
      vectors: [
        [0, 0, 0.9, 0.1, 0, 0, 0, 0],
        [0, 0, 0.85, 0.15, 0, 0, 0, 0],
      ],
    },
    {
      id: "d5",
      vectors: [
        [0, 0, 0, 0, 1, 0, 0, 0],
        [0, 0, 0, 0, 0.95, 0.05, 0, 0],
      ],
    },
    {
      id: "d6",
      vectors: [
        [0, 0, 0, 0, 0, 0, 1, 0],
        [0, 0, 0, 0, 0, 0, 0, 1],
      ],
    },
    { id: "d7", vectors: [[0, 0, 0, 0, 0, 0, 0, 0]], zero: true }, // 全零 chunk：norm=0 跳过
  ] as unknown as Array<{ id: string; vectors: number[][] }>);
}

test("int8-matrix-search: 剪枝结果与暴力参照逐位一致（多查询 × 多 limit）", () => {
  const data = buildFixture();
  const queries = [
    [1, 0, 0, 0, 0, 0, 0, 0], // 集中于 d1
    [0.7, 0.7, 0, 0, 0, 0, 0, 0], // d1/d2 并列附近
    [0, 0, 0.8, 0.2, 0, 0, 0, 0], // d3/d4 竞争
    [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3], // 均匀（低区分度，并列密集）
    [0, 0, 0, 0, 0, 0, 0, 1], // 只命中 d6 的第二个 chunk
    [0.2, 0.1, 0.4, 0.3, 0.5, 0.6, 0.7, 0.8], // 全维参与
  ];
  for (const q of queries) {
    const query = Float32Array.from(q);
    for (const limit of [1, 2, 3, 5, 7, 10]) {
      const got = searchChunkMatrix(data, query, limit);
      const want = bruteForceSearch(data, query, limit);
      assertSameResults(got, want, `查询 ${JSON.stringify(q)} limit=${limit}`);
    }
  }
});

test("int8-matrix-search: 剪枝在候选超过 limit 后确实生效（低分 chunk 被跳过不改变结果）", () => {
  // 8 个文档（每个 1 chunk），limit=2：只有前 2 个高分文档进 topK，
  // 后 6 个低分文档（得分远低于阈值）应被剪枝跳过——结果仍与暴力一致。
  // 用角度递减向量（cos(i·0.15) 单调递减）避免 int8 量化并列（如 [0.9,0..]
  // 与 [1,0..] 量化后同为 [127,0..]）。
  const docs = Array.from({ length: 8 }, (_, i) => ({
    id: `d${i + 1}`,
    vectors: [[Math.cos(i * 0.15), Math.sin(i * 0.15), 0, 0, 0, 0, 0, 0]],
  }));
  const data = matrixFromDocs(docs);
  const query = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const got = searchChunkMatrix(data, query, 2);
  const want = bruteForceSearch(data, query, 2);
  assertSameResults(got, want, "低分文档剪枝");
  assert.equal(got.length, 2);
  assert.equal(got[0]!.docId, "d1", "top-1 应为最高分文档");
  assert.equal(got[1]!.docId, "d2", "top-2 应为次高分文档");
  assert.ok(got[0]!.score > got[1]!.score, "得分应严格递减");
});

test("int8-matrix-search: 多 chunk 文档的文档级聚合在剪枝下保持", () => {
  // d1 有 3 个 chunk（高分+低分混合）：低分 chunk 被剪枝跳过，文档分仍取最高 chunk。
  const data = matrixFromDocs([
    {
      id: "d1",
      vectors: [
        [0.9, 0.1, 0, 0, 0, 0, 0, 0],
        [0.05, 0, 0, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, 0],
      ],
    },
    { id: "d2", vectors: [[0, 0.9, 0, 0, 0, 0, 0, 0]] },
    { id: "d3", vectors: [[0, 0, 1, 0, 0, 0, 0, 0]] },
    { id: "d4", vectors: [[0, 0, 0, 1, 0, 0, 0, 0]] },
  ]);
  const query = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const got = searchChunkMatrix(data, query, 3);
  const want = bruteForceSearch(data, query, 3);
  assertSameResults(got, want, "多 chunk 文档级聚合");
  assert.equal(got[0]!.docId, "d1");
  assert.ok(got[0]!.score > 0.99, "d1 文档分应为最高 chunk 的得分（≈1.0）");
});

test("int8-matrix-search: 边界——空矩阵/零 norm 查询/维度不匹配/limit<=0", () => {
  const empty = emptyChunkMatrix(DIM);
  assert.deepEqual(searchChunkMatrix(empty, Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]), 3), []);
  assert.deepEqual(searchChunkMatrix(empty, new Float32Array(DIM), 3), []);
  const data = buildFixture();
  assert.deepEqual(searchChunkMatrix(data, new Float32Array(DIM), 3), [], "全零查询应返回空");
  assert.deepEqual(searchChunkMatrix(data, new Float32Array(4), 3), [], "维度不匹配应返回空");
  assert.deepEqual(searchChunkMatrix(data, Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]), 0), []);
});

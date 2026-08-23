import assert from "node:assert/strict";
import test from "node:test";
import { runFtsThenLikeFallback, type FtsThenLikeOptions } from "../../../src/knowledge/shared/fts.js";

type Row = { id: string };

function makeOpts(overrides: Partial<FtsThenLikeOptions<Row>> = {}): FtsThenLikeOptions<Row> {
  return {
    useFts: true,
    minRunes: 3,
    keyword: "patent 检索",
    limit: 10,
    searchFts: () => [],
    searchFtsKeywords: () => [],
    searchLike: () => [],
    extractKeywords: () => ["patent"],
    onDegrade: () => {},
    ...overrides,
  };
}

test("empty keyword returns [] without calling any search", () => {
  let calls = 0;
  const opts = makeOpts({
    keyword: "   ",
    searchLike: () => {
      calls++;
      return [];
    },
  });
  assert.deepEqual(runFtsThenLikeFallback(opts), []);
  assert.equal(calls, 0);
});

test("useFts=false goes straight to LIKE", () => {
  let ftsCalls = 0;
  const opts = makeOpts({
    useFts: false,
    searchFts: () => {
      ftsCalls++;
      return [];
    },
    searchLike: () => [{ id: "like" }],
  });
  assert.deepEqual(runFtsThenLikeFallback(opts), [{ id: "like" }]);
  assert.equal(ftsCalls, 0);
});

test("short query (below minRunes) goes straight to LIKE", () => {
  let ftsCalls = 0;
  const opts = makeOpts({
    keyword: "ab",
    searchFts: () => {
      ftsCalls++;
      return [];
    },
    searchLike: () => [{ id: "like" }],
  });
  assert.deepEqual(runFtsThenLikeFallback(opts), [{ id: "like" }]);
  assert.equal(ftsCalls, 0);
});

test("non-empty FTS phrase result is returned directly", () => {
  let keywordCalls = 0;
  let likeCalls = 0;
  const opts = makeOpts({
    searchFts: () => [{ id: "a" }, { id: "b" }],
    searchFtsKeywords: () => {
      keywordCalls++;
      return [];
    },
    searchLike: () => {
      likeCalls++;
      return [];
    },
  });
  assert.deepEqual(runFtsThenLikeFallback(opts), [{ id: "a" }, { id: "b" }]);
  assert.equal(keywordCalls, 0);
  assert.equal(likeCalls, 0);
});

test("empty phrase falls back to keyword OR query", () => {
  const order: string[] = [];
  const opts = makeOpts({
    searchFts: () => {
      order.push("fts");
      return [];
    },
    searchFtsKeywords: () => {
      order.push("kw");
      return [{ id: "kw" }];
    },
    searchLike: () => {
      order.push("like");
      return [{ id: "like" }];
    },
    extractKeywords: () => ["patent", "检索"],
  });
  assert.deepEqual(runFtsThenLikeFallback(opts), [{ id: "kw" }]);
  assert.deepEqual(order, ["fts", "kw"]);
});

test("keyword step is skipped when the first keyword equals the query", () => {
  const order: string[] = [];
  const opts = makeOpts({
    searchFts: () => {
      order.push("fts");
      return [];
    },
    searchFtsKeywords: () => {
      order.push("kw");
      return [{ id: "kw" }];
    },
    searchLike: () => {
      order.push("like");
      return [{ id: "like" }];
    },
    extractKeywords: () => ["patent 检索"],
  });
  assert.deepEqual(runFtsThenLikeFallback(opts), [{ id: "like" }]);
  assert.deepEqual(order, ["fts", "like"]);
});

test("empty phrase + empty keywords falls back to LIKE", () => {
  const opts = makeOpts({
    searchFts: () => [],
    searchFtsKeywords: () => [],
    searchLike: () => [{ id: "like" }],
    extractKeywords: () => [],
  });
  assert.deepEqual(runFtsThenLikeFallback(opts), [{ id: "like" }]);
});

test("FTS throw degrades via onDegrade and falls back to LIKE", () => {
  let degradeMessage = "";
  const opts = makeOpts({
    searchFts: () => {
      throw new Error("no such module: fts5");
    },
    searchLike: () => [{ id: "like" }],
    onDegrade: msg => {
      degradeMessage = msg;
    },
  });
  assert.deepEqual(runFtsThenLikeFallback(opts), [{ id: "like" }]);
  assert.equal(degradeMessage, "no such module: fts5");
});

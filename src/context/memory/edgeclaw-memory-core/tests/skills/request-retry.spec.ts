// request-retry 行为基线测试（拆解自 llm-extraction.ts G1 纯函数，函数体逐字搬移）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_REQUEST_MAX_ATTEMPTS,
  computeRetryDelayMs,
  getErrorStatusCode,
  isTimeoutError,
  isTransientRequestError,
  resolveRequestTimeoutMs,
} from "../../src/core/skills/request-retry.js";

describe("isTimeoutError", () => {
  it("AbortError 判定为超时", () => {
    assert.equal(isTimeoutError(new DOMException("aborted", "AbortError")), true);
  });

  it("消息含 timeout 的 Error 判定为超时", () => {
    assert.equal(isTimeoutError(new Error("request timeout after 30s")), true);
  });

  it("普通错误不判定为超时", () => {
    assert.equal(isTimeoutError(new Error("boom")), false);
  });
});

describe("getErrorStatusCode", () => {
  it("从带 status 字段的错误提取", () => {
    assert.equal(getErrorStatusCode(Object.assign(new Error("x"), { status: 429 })), 429);
  });

  it("无 status 返回 null", () => {
    assert.equal(getErrorStatusCode(new Error("x")), null);
  });
});

describe("isTransientRequestError（重试判定）", () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
    it(`状态码 ${status} 可重试`, () => {
      assert.equal(isTransientRequestError(Object.assign(new Error("x"), { status })), true);
    });
  }

  it("非重试状态码（如 400）不可重试", () => {
    assert.equal(isTransientRequestError(Object.assign(new Error("x"), { status: 400 })), false);
  });

  it("网络类文案可重试", () => {
    assert.equal(isTransientRequestError(new Error("fetch failed: ECONNRESET")), true);
    assert.equal(isTransientRequestError(new Error("socket hang up")), true);
    assert.equal(isTransientRequestError(new Error("rate limit exceeded")), true);
  });

  it("普通错误不可重试", () => {
    assert.equal(isTransientRequestError(new Error("unexpected")), false);
  });

  it("非 Error 对象不可重试", () => {
    assert.equal(isTransientRequestError("boom"), false);
  });
});

describe("computeRetryDelayMs 指数退避", () => {
  it("1000 × 2^n", () => {
    assert.equal(computeRetryDelayMs(0), 1_000);
    assert.equal(computeRetryDelayMs(1), 2_000);
    assert.equal(computeRetryDelayMs(2), 4_000);
  });
});

describe("resolveRequestTimeoutMs", () => {
  it("undefined 默认 30s", () => {
    assert.equal(resolveRequestTimeoutMs(undefined), 30_000);
  });

  it("非有限数默认 30s", () => {
    assert.equal(resolveRequestTimeoutMs(Number.NaN), 30_000);
    assert.equal(resolveRequestTimeoutMs(Number.POSITIVE_INFINITY), 30_000);
  });

  it("≤0 返回 null（不限时）", () => {
    assert.equal(resolveRequestTimeoutMs(0), null);
    assert.equal(resolveRequestTimeoutMs(-5), null);
  });

  it("正数原样返回", () => {
    assert.equal(resolveRequestTimeoutMs(12_000), 12_000);
  });
});

describe("DEFAULT_REQUEST_MAX_ATTEMPTS", () => {
  it("重试上限为 3", () => {
    assert.equal(DEFAULT_REQUEST_MAX_ATTEMPTS, 3);
  });
});

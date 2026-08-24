import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, logger } from "../../src/telemetry/index.js";

/** 捕获 console 方法调用，返回所捕获的参数列表。 */
function capture(method: "log" | "warn" | "error") {
  const calls: unknown[][] = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore() {
      console[method] = original;
    },
  };
}

function withDebugEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.SATI_DEBUG;
  if (value === undefined) {
    delete process.env.SATI_DEBUG;
  } else {
    process.env.SATI_DEBUG = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env.SATI_DEBUG;
    } else {
      process.env.SATI_DEBUG = prev;
    }
  }
}

test("routes info to console.log, warn to console.warn, error to console.error", () => {
  const log = capture("log");
  const warn = capture("warn");
  const error = capture("error");
  try {
    const l = createLogger("sati");
    l.info("hello");
    l.warn("careful");
    l.error("boom");
    assert.deepEqual(log.calls, [["[sati] hello"]]);
    assert.deepEqual(warn.calls, [["[sati] careful"]]);
    assert.deepEqual(error.calls, [["[sati] boom"]]);
  } finally {
    log.restore();
    warn.restore();
    error.restore();
  }
});

test("namespace prefix: createLogger('sati') emits [sati] ; createLogger('') emits no prefix", () => {
  const warn = capture("warn");
  try {
    createLogger("sati").warn("m");
    createLogger("").warn("m");
    assert.deepEqual(warn.calls, [["[sati] m"], ["m"]]);
  } finally {
    warn.restore();
  }
});

test("nested namespace like agent:auto-compact keeps colon intact", () => {
  const warn = capture("warn");
  try {
    createLogger("agent:auto-compact").warn("failed");
    assert.deepEqual(warn.calls, [["[agent:auto-compact] failed"]]);
  } finally {
    warn.restore();
  }
});

test("levelTag and timestamp default to off", () => {
  const warn = capture("warn");
  try {
    createLogger("sati").warn("m");
    assert.deepEqual(warn.calls, [["[sati] m"]]);
  } finally {
    warn.restore();
  }
});

test("levelTag adds [warn] tag when enabled", () => {
  const warn = capture("warn");
  try {
    createLogger("sati", { levelTag: true }).warn("m");
    assert.deepEqual(warn.calls, [["[warn] [sati] m"]]);
  } finally {
    warn.restore();
  }
});

test("timestamp adds ISO prefix when enabled", () => {
  const warn = capture("warn");
  try {
    createLogger("sati", { timestamp: true }).warn("m");
    assert.equal(warn.calls.length, 1);
    assert.match(String(warn.calls[0]![0]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[sati\] m$/);
  } finally {
    warn.restore();
  }
});

test("debug is gated by SATI_DEBUG env", () => {
  const log = capture("log");
  try {
    const l = createLogger("sati");
    withDebugEnv(undefined, () => {
      l.debug("hidden");
      assert.equal(log.calls.length, 0);
    });
    withDebugEnv("1", () => {
      l.debug("visible");
      assert.deepEqual(log.calls, [["[sati] visible"]]);
    });
  } finally {
    log.restore();
  }
});

test("output never contains ANSI escape sequences", () => {
  const warn = capture("warn");
  try {
    createLogger("sati", { levelTag: true, timestamp: true }).warn("m");
    assert.equal(String(warn.calls[0]![0]).includes("["), false);
  } finally {
    warn.restore();
  }
});

test("rest args are passed through untouched", () => {
  const warn = capture("warn");
  const err = new Error("boom");
  try {
    createLogger("agent").warn("failed:", err);
    assert.equal(warn.calls.length, 1);
    assert.equal(warn.calls[0]![0], "[agent] failed:");
    assert.equal(warn.calls[0]![1], err);
  } finally {
    warn.restore();
  }
});

test("default singleton behaves like createLogger('sati')", () => {
  const warn = capture("warn");
  try {
    logger.warn("m");
    assert.deepEqual(warn.calls, [["[sati] m"]]);
  } finally {
    warn.restore();
  }
});

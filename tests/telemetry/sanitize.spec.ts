import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ANALYTICS_SCHEMA_VERSION, hashTelemetryId } from "../../src/telemetry/index.js";
import { sanitizeProperties } from "../../src/telemetry/collector.js";

test("ANALYTICS_SCHEMA_VERSION is analytics.v2", () => {
  assert.equal(ANALYTICS_SCHEMA_VERSION, "analytics.v2");
});

test("hashTelemetryId returns a deterministic 24-char hex hash", () => {
  const input = "session-key-123";
  const first = hashTelemetryId(input);
  const second = hashTelemetryId(input);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{24}$/);
  const expected = createHash("sha256").update(input).digest("hex").slice(0, 24);
  assert.equal(first, expected);
});

test("hashTelemetryId differs for different inputs", () => {
  assert.notEqual(hashTelemetryId("a"), hashTelemetryId("b"));
});

test("sanitizeProperties strips path-like keys case-insensitively", () => {
  const out = sanitizeProperties({
    module: "session",
    cwd: "/tmp/x",
    filePath: "/etc/passwd",
    projectRoot: "/repo",
    Dir: "/d",
    ok: true,
  });
  assert.deepEqual(out, { module: "session", ok: true });
});

test("sanitizeProperties strips absolute path values but keeps relative ones", () => {
  const out = sanitizeProperties({
    a: "/usr/local/bin",
    b: "C:\\Windows\\System32",
    c: "C:/Users/me",
    d: "./relative/path",
    e: "plain-string",
  });
  assert.deepEqual(out, { d: "./relative/path", e: "plain-string" });
});

test("sanitizeProperties recurses into arrays and drops path entries", () => {
  const out = sanitizeProperties({
    items: ["/abs/path", "keep", "/another"],
    empty: [],
  });
  assert.deepEqual(out, { items: ["keep"] });
});

test("sanitizeProperties recurses into nested objects", () => {
  const out = sanitizeProperties({
    meta: {
      provider: "anthropic",
      modelPath: "/abs",
      nested: { url: "/x", name: "ok" },
      emptyObj: {},
    },
  });
  assert.deepEqual(out, {
    meta: {
      provider: "anthropic",
      nested: { name: "ok" },
    },
  });
});

test("sanitizeProperties preserves null, numbers and booleans", () => {
  const out = sanitizeProperties({ n: null, zero: 0, flag: false, s: "" });
  assert.deepEqual(out, { n: null, zero: 0, flag: false, s: "" });
});

test("sanitizeProperties handles whitespace-padded absolute paths", () => {
  const out = sanitizeProperties({ p: "  /tmp/padded  " });
  assert.deepEqual(out, {});
});

import assert from "node:assert/strict";
import test from "node:test";
import { recursivelySanitizeUnicode, sanitizeUnicodeString } from "../../../src/mcp/runtime/sanitize.js";

test("sanitizeUnicodeString keeps plain ASCII and visible CJK", () => {
  assert.equal(sanitizeUnicodeString("read_file 中文"), "read_file 中文");
  assert.equal(sanitizeUnicodeString("café résumé"), "café résumé");
  assert.equal(sanitizeUnicodeString(""), "");
});

test("sanitizeUnicodeString strips zero-width and bidi control characters", () => {
  assert.equal(sanitizeUnicodeString("a\u200Bb"), "ab"); // ZERO WIDTH SPACE
  assert.equal(sanitizeUnicodeString("a\u200Db"), "ab"); // ZERO WIDTH JOINER
  assert.equal(sanitizeUnicodeString("\u202Eevil\u202C"), "evil"); // RTL OVERRIDE
  assert.equal(sanitizeUnicodeString("\u200Fabc\u200E"), "abc"); // RTL / LTR MARK
  assert.equal(sanitizeUnicodeString("a\uFEFFb"), "ab"); // BOM
  assert.equal(sanitizeUnicodeString("a\uFFFDb"), "ab"); // REPLACEMENT CHARACTER
});

test("sanitizeUnicodeString strips every listed code point", () => {
  const stripped =
    "\u200B\u200C\u200D\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\uFEFF\uFFFC\uFFFD";
  assert.equal(sanitizeUnicodeString(`x${stripped}y`), "xy");
});

test("recursivelySanitizeUnicode sanitizes strings and sanitizes object keys", () => {
  const input = {
    safe_key: "ok",
    "bad\u200Ekey": "value\u202E",
    nested: { "inner\u200B": "a\u200Cb" },
  };
  const out = recursivelySanitizeUnicode(input) as Record<string, unknown>;
  assert.equal(out.safe_key, "ok");
  assert.equal(out.badkey, "value");
  assert.equal((out.nested as Record<string, string>).inner, "ab");
  assert.equal("bad\u200Ekey" in out, false);
});

test("recursivelySanitizeUnicode sanitizes array elements", () => {
  const out = recursivelySanitizeUnicode(["a\u200Bb", { "k\u200C": "v\u200D" }]);
  assert.deepEqual(out, ["ab", { k: "v" }]);
});

test("recursivelySanitizeUnicode leaves non-string primitives untouched", () => {
  assert.deepEqual(recursivelySanitizeUnicode({ n: 42, b: true, nil: null }), { n: 42, b: true, nil: null });
  assert.equal(recursivelySanitizeUnicode(undefined), undefined);
});

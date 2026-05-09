import test from "node:test";
import assert from "node:assert/strict";
import {
  recursivelySanitizeUnicode,
  sanitizeUnicodeString,
} from "../../src/mcp/index.js";

test("C1.M9 sanitizeUnicodeString strips zero-width / BiDi / replacement chars", () => {
  const dangerous = "hi\u202Eevil\u200Bworld\uFFFD";
  assert.equal(sanitizeUnicodeString(dangerous), "hievilworld");
});

test("C1.M9 sanitizeUnicodeString preserves valid CJK and accents", () => {
  assert.equal(sanitizeUnicodeString("你好 résumé"), "你好 résumé");
});

test("C1.M9 recursivelySanitizeUnicode walks objects and arrays", () => {
  const input = {
    name: "tool\u202E",
    nested: { description: "desc\u200B", list: ["a\u200B", "b"] },
  };
  const out = recursivelySanitizeUnicode(input);
  assert.deepEqual(out, {
    name: "tool",
    nested: { description: "desc", list: ["a", "b"] },
  });
});

test("C1.M9 sanitizes object keys too", () => {
  const out = recursivelySanitizeUnicode({ ["key\u202D"]: 1 });
  assert.deepEqual(Object.keys(out as object), ["key"]);
});

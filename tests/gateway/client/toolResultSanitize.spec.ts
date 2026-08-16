import assert from "node:assert/strict";
import test from "node:test";
import {
  extensionForMime,
  headTailString,
  limitGatewayToolDataString,
  limitGatewayToolResultPreview,
  previewUnknown,
  safeGatewayPathPart,
  sanitizeGatewayToolData,
} from "../../../src/gateway/client/toolResultSanitize.js";

test("toolResultSanitize: 短文本直接返回（不截断）", () => {
  const text = "short result";
  assert.equal(limitGatewayToolResultPreview(text), text);
});

test("toolResultSanitize: 超长结果头尾对称截断 + 省略标记", () => {
  const text = "x".repeat(25_000);
  const preview = limitGatewayToolResultPreview(text);
  assert.ok(preview.length < text.length, "预览应短于原文");
  assert.match(preview, /Gateway preview truncated/);
  assert.ok(preview.startsWith("x"), "头部保留");
  assert.ok(preview.endsWith("x"), "尾部保留");
});

test("toolResultSanitize: sanitizeGatewayToolData 递归清洗长字符串", () => {
  const data = { nested: { deep: ["a".repeat(5_000)] }, plain: 42 };
  const out = sanitizeGatewayToolData(data);
  const deep = out.nested as { deep: unknown[] };
  assert.ok(deep.deep[0] && typeof deep.deep[0] === "object" && "truncated" in (deep.deep[0] as object));
});

test("toolResultSanitize: headTailString 头尾对称保留", () => {
  const text = "abcdefghij".repeat(10); // 100 字符
  const out = headTailString(text, 60, "label");
  assert.ok(out.startsWith("a"), "头部保留");
  assert.ok(out.endsWith("j"), "尾部保留");
  assert.match(out, /label/);
});

test("toolResultSanitize: limitGatewayToolDataString 短值透传", () => {
  assert.equal(limitGatewayToolDataString("ok"), "ok");
});

test("toolResultSanitize: previewUnknown / safeGatewayPathPart / extensionForMime", () => {
  assert.equal(previewUnknown(undefined), undefined);
  assert.equal(previewUnknown({ a: 1 }), '{"a":1}');
  assert.equal(safeGatewayPathPart("  abc/def.txt  "), "abc-def.txt");
  assert.equal(safeGatewayPathPart("///"), "value");
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("application/octet-stream"), "bin");
});

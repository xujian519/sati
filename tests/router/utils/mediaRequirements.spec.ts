import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalContentBlock, CanonicalMessage, MultimodalConstraints } from "../../../src/model/index.js";
import {
  collectRequiredInputModalities,
  missingInputModalities,
  supportsRequiredModalities,
} from "../../../src/router/utils/mediaRequirements.js";

function messageWith(blocks: CanonicalContentBlock[]): CanonicalMessage {
  return { role: "user", content: blocks };
}

function imageBlock(): CanonicalContentBlock {
  return {
    type: "image",
    mimeType: "image/png",
    path: "/a.png",
    preview: "p",
    originalBytes: 1,
    hasMore: false,
  } as unknown as CanonicalContentBlock;
}

function pdfBlock(): CanonicalContentBlock {
  return {
    type: "pdf",
    mimeType: "application/pdf",
    path: "/a.pdf",
    preview: "p",
    originalBytes: 1,
    hasMore: false,
  } as unknown as CanonicalContentBlock;
}

function audioBlock(): CanonicalContentBlock {
  return {
    type: "audio",
    mimeType: "audio/mp3",
    path: "/a.mp3",
    preview: "p",
    originalBytes: 1,
    hasMore: false,
  } as unknown as CanonicalContentBlock;
}

function toolResultWithMedia(blocks: Array<{ type: "image" | "pdf"; path: string }>): CanonicalContentBlock {
  return { type: "tool_result", toolCallId: "t1", content: blocks } as unknown as CanonicalContentBlock;
}

test("无媒体块时返回空数组", () => {
  const message = messageWith([{ type: "text", text: "hello" }]);
  assert.deepEqual(collectRequiredInputModalities([message]), []);
});

test("收集 image/pdf/audio 并按固定顺序返回", () => {
  const message = messageWith([audioBlock(), imageBlock(), pdfBlock()]);
  assert.deepEqual(collectRequiredInputModalities([message]), ["image", "pdf", "audio"]);
});

test("tool_result 内嵌的 image/pdf 也被收集", () => {
  const message = messageWith([toolResultWithMedia([{ type: "image", path: "/x.png" }])]);
  assert.deepEqual(collectRequiredInputModalities([message]), ["image"]);
});

test("多消息的媒体需求合并去重", () => {
  const a = messageWith([imageBlock()]);
  const b = messageWith([imageBlock(), audioBlock()]);
  assert.deepEqual(collectRequiredInputModalities([a, b]), ["image", "audio"]);
});

test("missingInputModalities：无必需媒体时返回空", () => {
  const constraints: MultimodalConstraints = { input: ["text"] };
  assert.deepEqual(missingInputModalities(constraints, []), []);
});

test("missingInputModalities：全部支持时返回空", () => {
  const constraints: MultimodalConstraints = { input: ["text", "image", "pdf", "audio"] };
  assert.deepEqual(missingInputModalities(constraints, ["image", "pdf"]), []);
});

test("missingInputModalities：仅返回缺失项", () => {
  const constraints: MultimodalConstraints = { input: ["text", "image"] };
  assert.deepEqual(missingInputModalities(constraints, ["image", "pdf", "audio"]), ["pdf", "audio"]);
});

test("supportsRequiredModalities：全部支持为 true，缺任一为 false", () => {
  const constraints: MultimodalConstraints = { input: ["text", "image"] };
  assert.equal(supportsRequiredModalities(constraints, ["image"]), true);
  assert.equal(supportsRequiredModalities(constraints, ["image", "pdf"]), false);
});

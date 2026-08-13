import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalContentBlock, CanonicalMessage, InputModality } from "../../../src/model/index.js";
import type { RouterFallbackConfig, RouterModelRef } from "../../../src/router/config/schema.js";
import { buildMediaRerouteCandidates, resolveMediaReroute } from "../../../src/router/utils/mediaReroute.js";

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

function textMessage(): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text: "hello" }] };
}

function imageMessage(): CanonicalMessage {
  return { role: "user", content: [imageBlock()] };
}

function toolResultImageMessage(): CanonicalMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolCallId: "t1", content: [imageBlock()] } as unknown as CanonicalContentBlock],
  };
}

function ref(provider: string, model: string): RouterModelRef {
  return { id: `${provider}/${model}`, provider, model };
}

/** 模拟 supports：按 provider/model 返回该模型支持的输入模态。 */
function supportsBy(
  supported: Record<string, InputModality[]>,
): (r: RouterModelRef, required: readonly InputModality[]) => boolean {
  return (r, required) => {
    const inputs = supported[`${r.provider}/${r.model}`] ?? ["text"];
    return required.every(modality => inputs.includes(modality));
  };
}

test("无媒体块 → no_media", () => {
  const result = resolveMediaReroute(
    { provider: "p1", model: "text-only" },
    [textMessage()],
    [ref("p1", "vision")],
    supportsBy({ "p1/vision": ["text", "image"] }),
  );
  assert.deepEqual(result, { status: "no_media" });
});

test("当前模型支持所需媒体 → already_supports", () => {
  const result = resolveMediaReroute(
    { provider: "p1", model: "vision" },
    [imageMessage()],
    [ref("p1", "vision2")],
    supportsBy({ "p1/vision": ["text", "image"] }),
  );
  assert.deepEqual(result, { status: "already_supports" });
});

test("当前模型不支持，候选有支持者 → routed", () => {
  const result = resolveMediaReroute(
    { provider: "p1", model: "text-only" },
    [imageMessage()],
    [ref("p1", "vision")],
    supportsBy({ "p1/vision": ["text", "image"] }),
  );
  assert.equal(result.status, "routed");
  if (result.status === "routed") {
    assert.deepEqual(result.required, ["image"]);
    assert.equal(result.from, "p1/text-only");
    assert.deepEqual(result.to, ref("p1", "vision"));
  }
});

test("当前模型不支持，候选无支持者 → no_candidate", () => {
  const result = resolveMediaReroute(
    { provider: "p1", model: "text-only" },
    [imageMessage()],
    [ref("p2", "also-text-only")],
    supportsBy({ "p2/also-text-only": ["text"] }),
  );
  assert.deepEqual(result, { status: "no_candidate", required: ["image"] });
});

test("候选顺序：命中第一个支持媒体的候选", () => {
  const result = resolveMediaReroute(
    { provider: "p1", model: "text-only" },
    [imageMessage()],
    [ref("p1", "vision-a"), ref("p1", "vision-b")],
    supportsBy({ "p1/vision-a": ["text", "image"], "p1/vision-b": ["text", "image"] }),
  );
  assert.equal(result.status, "routed");
  if (result.status === "routed") {
    assert.equal(result.to.model, "vision-a");
  }
});

test("tool_result 内嵌 image 也触发路由", () => {
  const result = resolveMediaReroute(
    { provider: "p1", model: "text-only" },
    [toolResultImageMessage()],
    [ref("p1", "vision")],
    supportsBy({ "p1/vision": ["text", "image"] }),
  );
  assert.equal(result.status, "routed");
  if (result.status === "routed") {
    assert.deepEqual(result.required, ["image"]);
  }
});

test("buildMediaRerouteCandidates：media 优先于场景键和 default", () => {
  const fallback: RouterFallbackConfig = {
    media: [ref("v", "vision")],
    default: [ref("a", "x")],
  };
  const candidates = buildMediaRerouteCandidates(fallback, "default");
  assert.deepEqual(
    candidates.map(c => c.id),
    ["v/vision", "a/x"],
  );
});

test("buildMediaRerouteCandidates：media 与 default 重复时去重", () => {
  const fallback: RouterFallbackConfig = {
    media: [ref("v", "vision")],
    default: [ref("v", "vision"), ref("a", "x")],
  };
  const candidates = buildMediaRerouteCandidates(fallback, "default");
  assert.deepEqual(
    candidates.map(c => c.id),
    ["v/vision", "a/x"],
  );
});

test("buildMediaRerouteCandidates：未配置 media 时回退场景键 + default", () => {
  const fallback: RouterFallbackConfig = {
    subagent: [ref("b", "y")],
    default: [ref("a", "x")],
  };
  const candidates = buildMediaRerouteCandidates(fallback, "subagent");
  assert.deepEqual(
    candidates.map(c => c.id),
    ["b/y", "a/x"],
  );
});

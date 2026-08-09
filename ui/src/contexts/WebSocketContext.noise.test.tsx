import { describe, expect, it } from "vitest";
import { isStreamingNoise } from "./WebSocketContext";

describe("isStreamingNoise", () => {
  it("filters bridge-normalized high-frequency `kind` frames", () => {
    // 桥侧归一化帧（ui/server/sati-bridge.js → eventMapping.ts）只带 kind 不带 type
    expect(isStreamingNoise({ kind: "stream_delta", content: "..." })).toBe(true);
    expect(isStreamingNoise({ kind: "thinking", content: "..." })).toBe(true);
    expect(isStreamingNoise({ kind: "tool_use", toolId: "t1" })).toBe(true);
    expect(isStreamingNoise({ kind: "tool_result", toolId: "t1" })).toBe(true);
    expect(isStreamingNoise({ kind: "agent_activity", activity: "..." })).toBe(true);
  });

  it("keeps filtering raw gateway event `type` frames", () => {
    expect(isStreamingNoise({ type: "assistant_text_delta", text: "..." })).toBe(true);
    expect(isStreamingNoise({ type: "assistant_thinking_delta", text: "..." })).toBe(true);
    expect(isStreamingNoise({ type: "tool_call_delta", delta: "..." })).toBe(true);
    expect(isStreamingNoise({ type: "tool_call_started", name: "read_file" })).toBe(true);
    expect(isStreamingNoise({ type: "tool_call_finished", name: "read_file" })).toBe(true);
    expect(isStreamingNoise({ type: "agent_status", status: "running" })).toBe(true);
  });

  it("lets low-frequency structural `type` frames through (consumers rely on latestMessage)", () => {
    expect(isStreamingNoise({ type: "session-status", sessionId: "s1" })).toBe(false);
    expect(isStreamingNoise({ type: "loading_progress", progress: 0.5 })).toBe(false);
    expect(isStreamingNoise({ type: "projects_updated" })).toBe(false);
    expect(isStreamingNoise({ type: "taskmaster-tasks-updated" })).toBe(false);
    expect(isStreamingNoise({ type: "taskmaster-mcp-status-changed" })).toBe(false);
  });

  it("lets low-frequency `kind` frames through (status/complete/error/permission etc.)", () => {
    expect(isStreamingNoise({ kind: "status", text: "started" })).toBe(false);
    expect(isStreamingNoise({ kind: "status", text: "structured", payload: {} })).toBe(false);
    expect(isStreamingNoise({ kind: "complete" })).toBe(false);
    expect(isStreamingNoise({ kind: "error", message: "boom" })).toBe(false);
    expect(isStreamingNoise({ kind: "permission_request", requestId: "r1" })).toBe(false);
    expect(isStreamingNoise({ kind: "permission_cancelled", requestId: "r1" })).toBe(false);
    expect(isStreamingNoise({ kind: "file_artifacts", artifacts: [] })).toBe(false);
    expect(isStreamingNoise({ kind: "compact_boundary" })).toBe(false);
    expect(isStreamingNoise({ kind: "session_created", sessionId: "s1" })).toBe(false);
    expect(isStreamingNoise({ kind: "subagent_link", subagentId: "a1" })).toBe(false);
  });

  it("ignores non-object payloads", () => {
    expect(isStreamingNoise(null)).toBe(false);
    expect(isStreamingNoise(undefined)).toBe(false);
    expect(isStreamingNoise("stream_delta")).toBe(false);
    expect(isStreamingNoise({})).toBe(false);
  });
});

/**
 * Behavioural tests for the `useSessionStore()` main closure (issue #159, TD-UI-CHAT-N02).
 *
 * The sibling `useSessionStore.streaming.test.ts` only exercises module-level
 * pure helpers. These cases drive the hook itself through `renderHook`, so the
 * per-session Map refs, the merged-projection cache and the streaming patch
 * ordering are covered by real assertions.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionProvider } from "../types/app";
import { type NormalizedMessage, useSessionStore } from "./useSessionStore";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  readAgentStatusErrorFromResponse: vi.fn(),
}));

vi.mock("../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
  readAgentStatusErrorFromResponse: mocks.readAgentStatusErrorFromResponse,
}));

const PROVIDER = "sati" as SessionProvider;
const SID_A = "web:s_alpha";
const SID_B = "web:s_beta";
const EARLY = "2020-01-01T00:00:00.000Z";

// jsdom only exposes rAF when `pretendToBeVisual` is on. `vi.stubGlobal` takes
// `unknown`, so this needs no double assertion (TD-UI-CHAT-N02 forbids
// introducing new ones).
if (typeof globalThis.requestAnimationFrame !== "function") {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
}

type TestResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(body: unknown, ok = true): TestResponse {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function message(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    sessionId: SID_A,
    timestamp: EARLY,
    provider: PROVIDER,
    kind: "text",
    role: "assistant",
    ...overrides,
  };
}

/** jsdom's rAF is a timer; flush one frame while React is inside `act`. */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 32));
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.authenticatedFetch.mockReset();
  mocks.readAgentStatusErrorFromResponse.mockReset();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("useSessionStore main closure", () => {
  it("fetchFromServer populates the slot and exposes messages through getMessages", async () => {
    mocks.authenticatedFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [message({ id: "s1", content: "hello" })], total: 1, hasMore: false }),
    );

    const { result } = renderHook(() => useSessionStore());
    await act(async () => {
      await result.current.fetchFromServer(SID_A, { provider: PROVIDER });
    });

    expect(result.current.getMessages(SID_A).map(m => m.content)).toEqual(["hello"]);
    const slot = result.current.getSessionSlot(SID_A);
    expect(slot?.status).toBe("idle");
    expect(slot?.total).toBe(1);
    expect(slot?.offset).toBe(1);
    expect(slot?.lastError).toBeNull();

    const [url, init] = mocks.authenticatedFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`/api/sessions/${encodeURIComponent(SID_A)}/messages?provider=${PROVIDER}`);
    expect(init).toMatchObject({ suppressServerErrorToast: true });
  });

  it("fetchFromServer records an error status when the response is not ok", async () => {
    mocks.readAgentStatusErrorFromResponse.mockResolvedValueOnce({ message: "Unable to load conversation messages" });
    mocks.authenticatedFetch.mockResolvedValueOnce(jsonResponse({}, false));

    const { result } = renderHook(() => useSessionStore());
    await act(async () => {
      await result.current.fetchFromServer(SID_A, { provider: PROVIDER });
    });

    const slot = result.current.getSessionSlot(SID_A);
    expect(slot?.status).toBe("error");
    expect(slot?.lastError).toBe("Unable to load conversation messages");
    expect(result.current.getMessages(SID_A)).toEqual([]);
  });

  it("appendRealtime merges live messages into the active session projection", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.setActiveSession(SID_A);
    });
    act(() => {
      result.current.appendRealtime(SID_A, message({ id: "rt1", content: "live", kind: "text", role: "user" }));
    });

    expect(result.current.getMessages(SID_A).map(m => m.id)).toEqual(["rt1"]);
    expect(result.current.has(SID_A)).toBe(true);
    expect(result.current.isStale(SID_A)).toBe(true);
  });

  it("keeps per-session slots isolated", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SID_A, message({ id: "a1", content: "alpha", sessionId: SID_A }));
      result.current.appendRealtime(SID_B, message({ id: "b1", content: "beta", sessionId: SID_B }));
    });

    expect(result.current.getMessages(SID_A).map(m => m.id)).toEqual(["a1"]);
    expect(result.current.getMessages(SID_B).map(m => m.id)).toEqual(["b1"]);
    expect(result.current.getSessionSlot(SID_A)).not.toBe(result.current.getSessionSlot(SID_B));
  });

  it("updateStreaming patches the merged row in place before mutating the realtime row", () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.updateStreaming(SID_A, "Hel", PROVIDER);
    });
    const firstMerged = result.current.getMessages(SID_A);
    expect(firstMerged.map(m => m.content)).toEqual(["Hel"]);

    act(() => {
      result.current.updateStreaming(SID_A, "Hello", PROVIDER);
    });
    const secondMerged = result.current.getMessages(SID_A);
    expect(secondMerged.map(m => m.content)).toEqual(["Hello"]);
    // patchMergedStreamingMessage copies the row and re-slices `merged`, so the
    // projection identity MUST change on a real content update. If the patch
    // runs after `existing.content = accumulatedText`, the helper early-returns
    // and this reference stays identical while the text silently appears to
    // update (the UI memo would keep the stale array).
    expect(secondMerged).not.toBe(firstMerged);

    // Identical content + provider short-circuits without recomputing.
    act(() => {
      result.current.updateStreaming(SID_A, "Hello", PROVIDER);
    });
    expect(result.current.getMessages(SID_A)).toBe(secondMerged);
  });

  it("finalizeStreaming replaces the well-known streaming id with a unique text row", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(SID_A, "done", PROVIDER);
      result.current.finalizeStreaming(SID_A);
    });

    const realtime = result.current.getSessionSlot(SID_A)?.realtimeMessages ?? [];
    expect(realtime).toHaveLength(1);
    expect(realtime[0].id.startsWith("text_")).toBe(true);
    expect(realtime[0].kind).toBe("text");
    expect(realtime[0].role).toBe("assistant");
    expect(realtime[0].isFinal).toBe(true);
    expect(result.current.getMessages(SID_A).map(m => m.id)).toEqual([realtime[0].id]);
  });

  it("keeps thinking and text streams on separate rows", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(SID_A, "answer", PROVIDER);
      result.current.updateStreamingThinking(SID_A, "reasoning", PROVIDER);
    });
    expect(result.current.getSessionSlot(SID_A)?.realtimeMessages.map(m => m.kind)).toEqual([
      "stream_delta",
      "thinking",
    ]);

    act(() => {
      result.current.finalizeStreamingThinking(SID_A);
    });
    const realtime = result.current.getSessionSlot(SID_A)?.realtimeMessages ?? [];
    expect(realtime).toHaveLength(2);
    expect(realtime[0].id.startsWith("__streaming_")).toBe(true);
    expect(realtime[1].kind).toBe("thinking");
    expect(realtime[1].id.startsWith("thinking_")).toBe(true);
  });

  it("prunes realtime messages already covered by a server fetch", async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SID_A, message({ id: "local_1", kind: "text", role: "user", content: "hi there" }));
    });
    expect(result.current.getSessionSlot(SID_A)?.realtimeMessages).toHaveLength(1);

    mocks.authenticatedFetch.mockResolvedValueOnce(
      jsonResponse({
        messages: [message({ id: "s1", kind: "text", role: "user", content: "hi  there" })],
        total: 1,
        hasMore: false,
      }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SID_A, { provider: PROVIDER });
    });

    expect(result.current.getSessionSlot(SID_A)?.realtimeMessages).toEqual([]);
    expect(result.current.getMessages(SID_A).map(m => m.id)).toEqual(["s1"]);
  });

  it("keeps an in-flight streaming row across a server refresh", async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.updateStreaming(SID_A, "partial answer", PROVIDER);
    });

    mocks.authenticatedFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [message({ id: "s0", content: "old turn" })], total: 1, hasMore: false }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SID_A, { provider: PROVIDER });
    });

    const realtime = result.current.getSessionSlot(SID_A)?.realtimeMessages ?? [];
    expect(realtime).toHaveLength(1);
    expect(realtime[0].id).toBe(`__streaming_${SID_A}`);
    expect(result.current.getMessages(SID_A).map(m => m.id)).toEqual(["s0", `__streaming_${SID_A}`]);
  });

  it("refreshFromServer does not wipe existing server messages with an empty response", async () => {
    const { result } = renderHook(() => useSessionStore());
    mocks.authenticatedFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [message({ id: "s1", content: "committed" })], total: 1, hasMore: false }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SID_A, { provider: PROVIDER });
    });

    mocks.authenticatedFetch.mockResolvedValueOnce(jsonResponse({ messages: [], total: 0, hasMore: false }));
    await act(async () => {
      await result.current.refreshFromServer(SID_A, { provider: PROVIDER });
    });

    const slot = result.current.getSessionSlot(SID_A);
    expect(slot?.serverMessages.map(m => m.id)).toEqual(["s1"]);
    // `data.total ?? slot.serverMessages.length` keeps the server's explicit 0
    // (?? only falls back on null/undefined), so the count still tracks the
    // empty response even though the message array is preserved.
    expect(slot?.total).toBe(0);
    expect(result.current.getMessages(SID_A).map(m => m.id)).toEqual(["s1"]);
  });

  it("fetchMore prepends older pages and stops when the server says there is no more", async () => {
    const { result } = renderHook(() => useSessionStore());
    mocks.authenticatedFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [message({ id: "s2", content: "newer" })], total: 2, hasMore: true }),
    );
    await act(async () => {
      await result.current.fetchFromServer(SID_A, { provider: PROVIDER, limit: 1 });
    });

    mocks.authenticatedFetch.mockResolvedValueOnce(
      jsonResponse({ messages: [message({ id: "s1", content: "older" })], total: 2, hasMore: false }),
    );
    await act(async () => {
      await result.current.fetchMore(SID_A, { provider: PROVIDER });
    });

    const slot = result.current.getSessionSlot(SID_A);
    expect(slot?.serverMessages.map(m => m.id)).toEqual(["s1", "s2"]);
    expect(slot?.hasMore).toBe(false);
    expect(slot?.offset).toBe(2);

    const callsAfterPaging = mocks.authenticatedFetch.mock.calls.length;
    await act(async () => {
      await result.current.fetchMore(SID_A, { provider: PROVIDER });
    });
    expect(mocks.authenticatedFetch.mock.calls.length).toBe(callsAfterPaging);
  });

  it("skips merged recomputation for invisible realtime kinds", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SID_A, message({ id: "st1", kind: "status", role: undefined, content: "busy" }));
    });

    const slot = result.current.getSessionSlot(SID_A);
    expect(slot?.realtimeMessages.map(m => m.id)).toEqual(["st1"]);
    expect(result.current.getMessages(SID_A)).toEqual([]);

    act(() => {
      result.current.appendRealtime(SID_A, message({ id: "t1", content: "visible" }));
    });
    expect(result.current.getMessages(SID_A).map(m => m.id)).toEqual(["st1", "t1"]);
  });

  it("caps the realtime buffer at the newest 500 messages", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      for (let index = 0; index < 501; index += 1) {
        result.current.appendRealtime(SID_A, message({ id: `m${index}`, content: `c${index}` }));
      }
    });

    const realtime = result.current.getSessionSlot(SID_A)?.realtimeMessages ?? [];
    expect(realtime).toHaveLength(500);
    expect(realtime[0].id).toBe("m1");
    expect(realtime[499].id).toBe("m500");
  });

  it("clearRealtime and clearAssistantRealtime prune live rows", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SID_A, message({ id: "u1", kind: "text", role: "user", content: "ask" }));
      result.current.appendRealtime(SID_A, message({ id: "a1", kind: "text", role: "assistant", content: "reply" }));
      result.current.appendRealtime(SID_A, message({ id: "th1", kind: "thinking", role: "assistant", content: "hmm" }));
    });

    act(() => {
      result.current.clearAssistantRealtime(SID_A);
    });
    expect(result.current.getSessionSlot(SID_A)?.realtimeMessages.map(m => m.id)).toEqual(["u1"]);
    expect(result.current.getMessages(SID_A).map(m => m.id)).toEqual(["u1"]);

    act(() => {
      result.current.clearRealtime(SID_A);
    });
    expect(result.current.getSessionSlot(SID_A)?.realtimeMessages).toEqual([]);
    expect(result.current.getMessages(SID_A)).toEqual([]);
  });

  it("tracks subagent links and detail streams per subagent", () => {
    const { result } = renderHook(() => useSessionStore());
    const linkMessage = { ...message({ id: "link1" }), toolCallId: "tc1", subagentId: "sa1" } as NormalizedMessage;

    act(() => {
      result.current.recordSubagentLink(SID_A, linkMessage);
    });
    expect(result.current.getSessionSlot(SID_A)?.subagentLinks.get("tc1")).toEqual({
      subagentId: "sa1",
      subagentType: "agent",
    });

    act(() => {
      result.current.appendSubagentDetailMessage(SID_A, "sa1", message({ id: "d1", content: "start" }));
      result.current.updateSubagentDetailStreaming(SID_A, "sa1", "Hel", PROVIDER);
      result.current.updateSubagentDetailStreaming(SID_A, "sa1", "lo", PROVIDER);
      result.current.finalizeSubagentDetailStreaming(SID_A, "sa1");
    });

    const detail = result.current.getSubagentDetailMessages(SID_A, "sa1");
    expect(detail.map(m => m.id)).toEqual(["d1", expect.stringMatching(/^subagent_text_/)]);
    expect(detail[1].content).toBe("Hello");
    expect(detail[1].kind).toBe("text");
    expect(result.current.getSubagentDetailMessages(SID_A, "unknown")).toEqual([]);
  });

  it("notifies React only for the active session", async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSessionStore();
    });
    act(() => {
      result.current.setActiveSession(SID_A);
    });
    await flushFrame();
    const afterActivate = renders;

    act(() => {
      result.current.appendRealtime(SID_A, message({ id: "a1", content: "alpha", sessionId: SID_A }));
    });
    await flushFrame();
    expect(renders).toBe(afterActivate + 1);

    const afterActiveAppend = renders;
    act(() => {
      result.current.appendRealtime(SID_B, message({ id: "b1", content: "beta", sessionId: SID_B }));
    });
    await flushFrame();
    expect(renders).toBe(afterActiveAppend);
    expect(result.current.getMessages(SID_B).map(m => m.id)).toEqual(["b1"]);
  });

  it("reports staleness from the fetch watermark and defaults unknown sessions to stale", async () => {
    const { result } = renderHook(() => useSessionStore());
    expect(result.current.isStale("web:never_seen")).toBe(true);

    mocks.authenticatedFetch.mockResolvedValueOnce(jsonResponse({ messages: [], total: 0, hasMore: false }));
    await act(async () => {
      await result.current.fetchFromServer(SID_A, { provider: PROVIDER });
    });
    expect(result.current.isStale(SID_A)).toBe(false);
  });

  it("dedupes agent activity rows by activityId in upsertActivity and setActivities", () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.upsertActivity(SID_A, message({ id: "x1", kind: "agent_activity", activityId: "act1" }));
      result.current.upsertActivity(SID_A, message({ id: "x2", kind: "agent_activity", activityId: "act1" }));
    });
    expect(result.current.getActivityMessages(SID_A).map(m => m.id)).toEqual(["x2"]);

    act(() => {
      result.current.setActivities(SID_A, [
        message({ id: "y1", kind: "agent_activity", activityId: "act2" }),
        message({ id: "y2", kind: "text" }),
        message({ id: "y3", kind: "agent_activity", activityId: "act3" }),
      ]);
    });
    expect(result.current.getActivityMessages(SID_A).map(m => m.id)).toEqual(["y1", "y3"]);
  });
});

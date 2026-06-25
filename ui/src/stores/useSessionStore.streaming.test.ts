// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionProvider } from '../types/app';
import {
  createRafNotifyScheduler,
  patchMergedStreamingMessage,
  useSessionStore,
  type NormalizedMessage,
  type SessionSlot,
} from './useSessionStore';

const PROVIDER = 'pilotdeck' as SessionProvider;

function makeSlot(overrides: Partial<SessionSlot> = {}): SessionSlot {
  return {
    serverMessages: [],
    realtimeMessages: [],
    activityMessages: [],
    merged: [],
    _lastServerRef: [],
    _lastRealtimeRef: [],
    status: 'streaming',
    fetchedAt: 0,
    lastError: null,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    ...overrides,
  };
}

function streamingMessage(sessionId: string, content: string): NormalizedMessage {
  return {
    id: `__streaming_${sessionId}`,
    sessionId,
    timestamp: '2026-05-28T00:00:00.000Z',
    provider: PROVIDER,
    kind: 'stream_delta',
    content,
  };
}

describe('patchMergedStreamingMessage', () => {
  it('updates merged content and refreshes the merged array reference', () => {
    const sessionId = 'web:s_test';
    const streamId = `__streaming_${sessionId}`;
    const merged = [streamingMessage(sessionId, 'hello')];
    const slot = makeSlot({
      realtimeMessages: [streamingMessage(sessionId, 'hello')],
      merged,
      _lastRealtimeRef: [streamingMessage(sessionId, 'hello')],
    });

    const mergedBefore = slot.merged;
    const patched = patchMergedStreamingMessage(slot, streamId, 'hello world', PROVIDER);

    expect(patched).toBe(true);
    expect(slot.merged).not.toBe(mergedBefore);
    expect(slot.merged[0]?.content).toBe('hello world');
  });

  it('returns false when the streaming row is not yet in merged', () => {
    const slot = makeSlot();
    expect(patchMergedStreamingMessage(slot, '__streaming_missing', 'text', PROVIDER)).toBe(false);
  });

  it('skips object replacement when content is unchanged', () => {
    const sessionId = 'web:s_test';
    const streamId = `__streaming_${sessionId}`;
    const row = streamingMessage(sessionId, 'same');
    const slot = makeSlot({ merged: [row] });
    const rowBefore = slot.merged[0];

    patchMergedStreamingMessage(slot, streamId, 'same', PROVIDER);

    expect(slot.merged[0]).toBe(rowBefore);
  });
});

describe('streaming finalization dedupe', () => {
  it('does not duplicate assistant text when a final text frame arrived before stream_end', () => {
    const sessionId = 'web:s_text_dedupe';
    const finalText = '你好！有什么可以帮你的？';
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.updateStreaming(sessionId, finalText, PROVIDER);
      result.current.appendRealtime(sessionId, {
        id: 'server-text-1',
        sessionId,
        timestamp: '2026-06-25T12:00:01.000Z',
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content: finalText,
      });
      result.current.finalizeStreaming(sessionId);
    });

    const realtimeAssistantTexts = result.current.getSessionSlot(sessionId)?.realtimeMessages.filter((message) =>
      message.kind === 'text' && message.role === 'assistant' && message.content === finalText
    );
    const mergedAssistantTexts = result.current.getMessages(sessionId).filter((message) =>
      message.kind === 'text' && message.role === 'assistant' && message.content === finalText
    );

    expect(realtimeAssistantTexts).toHaveLength(1);
    expect(mergedAssistantTexts).toHaveLength(1);
  });

  it('does not duplicate finalized thinking when a matching thinking frame is finalized later', () => {
    const sessionId = 'web:s_thinking_dedupe';
    const thinkingText = '用户打招呼，我需要简短回应。';
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.updateStreamingThinking(sessionId, thinkingText, PROVIDER);
      result.current.finalizeStreamingThinking(sessionId);
      result.current.updateStreamingThinking(sessionId, thinkingText, PROVIDER);
      result.current.finalizeStreamingThinking(sessionId);
    });

    const realtimeThinking = result.current.getSessionSlot(sessionId)?.realtimeMessages.filter((message) =>
      message.kind === 'thinking' && message.content === thinkingText
    );
    const mergedThinking = result.current.getMessages(sessionId).filter((message) =>
      message.kind === 'thinking' && message.content === thinkingText
    );

    expect(realtimeThinking).toHaveLength(1);
    expect(mergedThinking).toHaveLength(1);
  });
});

describe('createRafNotifyScheduler', () => {
  it('coalesces multiple schedules for the same session into one frame callback', () => {
    const frames: Array<() => void> = [];
    let activeSessionId: string | null = 'web:s_1';
    let notifyCount = 0;

    const scheduler = createRafNotifyScheduler(
      (sessionId) => sessionId === activeSessionId,
      () => {
        notifyCount += 1;
      },
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      () => {},
    );

    scheduler.schedule('web:s_1');
    scheduler.schedule('web:s_1');
    scheduler.schedule('web:s_1');

    expect(frames).toHaveLength(1);

    frames[0]?.();
    expect(notifyCount).toBe(1);

    scheduler.schedule('web:s_1');
    expect(frames).toHaveLength(2);
  });

  it('does not schedule when the session is not active', () => {
    const frames: Array<() => void> = [];
    const onNotify = vi.fn();

    const scheduler = createRafNotifyScheduler(
      () => false,
      onNotify,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      () => {},
    );

    scheduler.schedule('web:s_1');
    expect(frames).toHaveLength(0);
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('cancelAll clears pending frame callbacks', () => {
    const frames: Array<() => void> = [];
    const cancelled: number[] = [];
    const onNotify = vi.fn();

    const scheduler = createRafNotifyScheduler(
      () => true,
      onNotify,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      (handle) => {
        cancelled.push(handle);
      },
    );

    scheduler.schedule('web:s_1');
    scheduler.cancelAll();

    expect(cancelled).toEqual([1]);
    frames[0]?.();
    expect(onNotify).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types/types';
import {
  BOTTOM_FOLLOW_THRESHOLD_PX,
  getStreamContentKey,
  isScrollNearBottom,
} from './useChatSessionState';

describe('useChatSessionState scroll helpers', () => {
  it('uses a wider bottom threshold for streaming follow mode', () => {
    expect(isScrollNearBottom(805, 1000, 100)).toBe(true);
    expect(isScrollNearBottom(803, 1000, 100)).toBe(false);
    expect(BOTTOM_FOLLOW_THRESHOLD_PX).toBe(96);
  });

  it('changes the stream content key when the last visible message grows', () => {
    const baseMessages: ChatMessage[] = [
      {
        id: 'user-1',
        type: 'user',
        content: 'hello',
        timestamp: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'assistant-1',
        type: 'assistant',
        content: 'partial',
        timestamp: '2026-05-18T00:00:01.000Z',
        isStreaming: true,
      },
    ];
    const nextMessages: ChatMessage[] = [
      baseMessages[0],
      {
        ...baseMessages[1],
        content: 'partial response keeps growing',
      },
    ];

    expect(getStreamContentKey(nextMessages)).not.toBe(getStreamContentKey(baseMessages));
  });

  it('changes the stream content key when a streamed tool result grows without changing message count', () => {
    const baseMessages: ChatMessage[] = [
      {
        id: 'tool-1',
        type: 'assistant',
        content: '',
        timestamp: '2026-05-18T00:00:01.000Z',
        isToolUse: true,
        toolName: 'Bash',
        toolResult: { content: 'line 1', isError: false },
      },
    ];
    const nextMessages: ChatMessage[] = [
      {
        ...baseMessages[0],
        toolResult: { content: 'line 1\nline 2', isError: false },
      },
    ];

    expect(getStreamContentKey(nextMessages)).not.toBe(getStreamContentKey(baseMessages));
  });
});

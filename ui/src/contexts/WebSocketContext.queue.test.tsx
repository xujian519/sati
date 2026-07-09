import { describe, expect, it } from 'vitest';
import {
  enqueueDisconnectedMessage,
  getQueuedMessageKey,
} from './WebSocketContext';

describe('WebSocket disconnected send queue', () => {
  it('does not dedupe pilotdeck commands', () => {
    const queue: any[] = [];

    enqueueDisconnectedMessage(queue, { type: 'pilotdeck-command', text: 'one' });
    enqueueDisconnectedMessage(queue, { type: 'pilotdeck-command', text: 'two' });

    expect(queue.map((message) => message.text)).toEqual(['one', 'two']);
  });

  it('dedupes check-session-status by sessionId and keeps the latest message', () => {
    const queue: any[] = [];

    enqueueDisconnectedMessage(queue, {
      type: 'check-session-status',
      sessionId: 'session-1',
      includeActiveTurnMessages: false,
    });
    enqueueDisconnectedMessage(queue, {
      type: 'check-session-status',
      sessionId: 'session-1',
      includeActiveTurnMessages: true,
    });

    expect(queue).toEqual([{
      type: 'check-session-status',
      sessionId: 'session-1',
      includeActiveTurnMessages: true,
    }]);
  });

  it('does not make unsafe control messages queueable', () => {
    expect(getQueuedMessageKey({ type: 'abort-session', sessionId: 'session-1' })).toBeNull();
    expect(getQueuedMessageKey({ type: 'permission-response', sessionId: 'session-1' })).toBeNull();
    expect(getQueuedMessageKey({ type: 'watch-session', sessionId: 'session-1' })).toBeNull();
  });

  it('drops the oldest messages when the queue exceeds its cap', () => {
    const queue: any[] = [];

    enqueueDisconnectedMessage(queue, { type: 'pilotdeck-command', text: 'one' }, 2);
    enqueueDisconnectedMessage(queue, { type: 'pilotdeck-command', text: 'two' }, 2);
    enqueueDisconnectedMessage(queue, { type: 'pilotdeck-command', text: 'three' }, 2);

    expect(queue.map((message) => message.text)).toEqual(['two', 'three']);
  });
});

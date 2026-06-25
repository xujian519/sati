import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

describe('normalizedToChatMessages', () => {
  it('preserves assistant entry ids for history fork actions', () => {
    const messages: NormalizedMessage[] = [
      {
        id: 'assistant-message-1',
        entryId: 'assistant-entry-1',
        sessionId: 'web:s_test',
        timestamp: '2026-06-25T08:00:00.000Z',
        provider: 'pilotdeck',
        kind: 'text',
        role: 'assistant',
        content: 'Ready to fork this answer.',
      },
    ];

    expect(normalizedToChatMessages(messages)).toEqual([
      {
        id: 'assistant-message-1',
        entryId: 'assistant-entry-1',
        type: 'assistant',
        content: 'Ready to fork this answer.',
        timestamp: '2026-06-25T08:00:00.000Z',
      },
    ]);
  });
});

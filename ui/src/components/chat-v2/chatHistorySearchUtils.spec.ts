// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import {
  buildSearchableMessages,
  findChatHistoryMatches,
  highlightActiveMatch,
} from './chatHistorySearchUtils';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('chatHistorySearchUtils', () => {
  it('does not index successful tool results that the UI hides', () => {
    const readMessage: ChatMessage = {
      id: 'read-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'Read',
      toolId: 'read-1',
      toolInput: '{"file_path":"src/App.tsx"}',
      toolResult: { content: 'hidden-file-content-needle', isError: false },
    };

    const searchableMessages = buildSearchableMessages([
      { message: readMessage, messageKey: 'm1' },
    ]);

    expect(findChatHistoryMatches(searchableMessages, 'hidden-file-content-needle')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'src/App.tsx')).toHaveLength(1);
  });

  it('does not index collapsed thinking or subagent container content', () => {
    const thinkingMessage: ChatMessage = {
      id: 'thinking-1',
      type: 'assistant',
      content: 'hidden thinking needle',
      timestamp: '2026-05-18T08:00:00.000Z',
      isThinking: true,
    };
    const subagentMessage: ChatMessage = {
      id: 'subagent-1',
      type: 'assistant',
      content: 'hidden subagent needle',
      timestamp: '2026-05-18T08:00:01.000Z',
      isSubagentContainer: true,
    };

    const searchableMessages = buildSearchableMessages([
      { message: thinkingMessage, messageKey: 'thinking-1' },
      { message: subagentMessage, messageKey: 'subagent-1' },
    ]);

    expect(searchableMessages).toHaveLength(0);
  });

  it('highlights the active occurrence when earlier matches are in previous text nodes', () => {
    const container = document.createElement('div');
    const message = document.createElement('div');
    const firstSpan = document.createElement('span');
    const secondSpan = document.createElement('span');

    message.className = 'chat-message';
    message.dataset.messageKey = 'message:1';
    firstSpan.textContent = 'needle in the first node ';
    secondSpan.textContent = 'needle in the second node';
    message.append(firstSpan, secondSpan);
    container.append(message);
    document.body.append(container);

    const highlighted = highlightActiveMatch(
      container,
      'message:1',
      'needle in the first node needle in the second node',
      'needle',
      'needle in the first node '.length,
    );

    const marks = Array.from(message.querySelectorAll('mark.chat-history-search-highlight-active'));

    expect(highlighted).toBe(true);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('needle');
    expect(marks[0].parentElement).toBe(secondSpan);
    expect(firstSpan.querySelector('mark')).toBeNull();
  });

});

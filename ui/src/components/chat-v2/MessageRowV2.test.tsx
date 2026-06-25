// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import MessageRowV2 from './MessageRowV2';

afterEach(() => {
  cleanup();
});

const baseTime = '2026-06-25T08:00:00.000Z';

function renderMessageRow(
  message: ChatMessage,
  overrides: Partial<ComponentProps<typeof MessageRowV2>> = {},
) {
  return render(
    <MessageRowV2
      message={message}
      prevMessage={null}
      provider="pilotdeck"
      selectedProject={null}
      createDiff={() => []}
      {...overrides}
    />,
  );
}

describe('MessageRowV2 fork actions', () => {
  it('renders assistant fork next to copy and invokes fork with the assistant message', () => {
    const onFork = vi.fn();
    const assistantMessage: ChatMessage = {
      id: 'assistant-1',
      entryId: 'assistant-entry-1',
      type: 'assistant',
      content: 'Here is the finished answer.',
      timestamp: baseTime,
    };

    renderMessageRow(assistantMessage, {
      forkCarriedMessageCount: 2,
      onFork,
    });

    const forkButton = screen.getByRole('button', {
      name: 'Fork from here · carries 2 messages',
    });
    const copyButton = screen.getByRole('button', { name: 'Copy' });

    expect(forkButton.parentElement).toBe(copyButton.parentElement);
    expect((forkButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(forkButton);

    expect(onFork).toHaveBeenCalledTimes(1);
    expect(onFork).toHaveBeenCalledWith(assistantMessage, 2);
  });

  it('does not invoke assistant fork when the message has no entry id', () => {
    const onFork = vi.fn();
    const assistantMessage: ChatMessage = {
      id: 'assistant-no-entry',
      type: 'assistant',
      content: 'This message came from older history.',
      timestamp: baseTime,
    };

    renderMessageRow(assistantMessage, {
      forkCarriedMessageCount: 1,
      onFork,
    });

    const forkButton = screen.getByRole('button', {
      name: 'Fork from here · carries 1 messages',
    });

    expect((forkButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(forkButton);

    expect(onFork).not.toHaveBeenCalled();
  });

  it('keeps the existing user fork affordance wired through the same callback', () => {
    const onFork = vi.fn();
    const userMessage: ChatMessage = {
      id: 'user-1',
      entryId: 'user-entry-1',
      type: 'user',
      content: 'Please review this.',
      timestamp: baseTime,
    };

    renderMessageRow(userMessage, {
      forkCarriedMessageCount: 0,
      onFork,
    });

    const forkButton = screen.getByRole('button', {
      name: 'Fork from here · carries 0 messages',
    });

    expect(forkButton.className).toContain('group-hover/user-msg:opacity-100');

    fireEvent.click(forkButton);

    expect(onFork).toHaveBeenCalledTimes(1);
    expect(onFork).toHaveBeenCalledWith(userMessage, 0);
  });
});

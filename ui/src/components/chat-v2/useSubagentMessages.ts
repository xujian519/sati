import { useEffect, useMemo, useState, useRef } from 'react';
import type { ChatMessage } from '../chat/types/types';
import { normalizedToChatMessages } from '../chat/hooks/useChatMessages';
import type { NormalizedMessage, SessionStore } from '../../stores/useSessionStore';

interface SubagentMessagesResult {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
}

function isPilotDeckForkDirective(message: ChatMessage): boolean {
  if (typeof message.content !== 'string') return false;
  return message.content.includes('<pilotdeck-fork>') &&
    message.content.includes('Directive:');
}

function filterSubagentDetailMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) =>
    !message.isThinking &&
    !message.isSubagentContainer &&
    !isPilotDeckForkDirective(message)
  );
}

function mergeSubagentDetailMessages(
  snapshotMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  useSnapshotOnly: boolean,
): NormalizedMessage[] {
  if (useSnapshotOnly && snapshotMessages.length > 0) {
    return snapshotMessages;
  }

  const merged = [...snapshotMessages];
  const seen = new Set(snapshotMessages.map((message) => message.id));
  for (const message of realtimeMessages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

export function useSubagentMessages(
  sessionId: string | null,
  subagentId: string | null,
  projectPath?: string,
  sessionStore?: SessionStore,
  refreshKey?: string,
): SubagentMessagesResult {
  const [snapshotMessages, setSnapshotMessages] = useState<NormalizedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const realtimeMessages = sessionId && subagentId
    ? sessionStore?.getSubagentDetailMessages?.(sessionId, subagentId) ?? []
    : [];
  const useSnapshotOnly = refreshKey === 'completed' || refreshKey === 'failed';
  const messages = useMemo(() => {
    const normalized = mergeSubagentDetailMessages(snapshotMessages, realtimeMessages, useSnapshotOnly);
    return filterSubagentDetailMessages(normalizedToChatMessages(normalized));
  }, [snapshotMessages, realtimeMessages, useSnapshotOnly]);

  useEffect(() => {
    if (!sessionId || !subagentId) {
      setSnapshotMessages([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (projectPath) params.set('projectPath', projectPath);
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(subagentId)}/messages?${params}`;

    fetch(url, { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        if (controller.signal.aborted) return;
        const normalized = Array.isArray(data.messages) ? data.messages : [];
        setSnapshotMessages(normalized);
        setIsLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [sessionId, subagentId, projectPath, refreshKey]);

  return { messages, isLoading, error };
}

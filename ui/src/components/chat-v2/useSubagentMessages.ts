import { useEffect, useState, useRef } from 'react';
import type { ChatMessage } from '../chat/types/types';
import { normalizedToChatMessages } from '../chat/hooks/useChatMessages';

interface SubagentMessagesResult {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
}

export function useSubagentMessages(
  sessionId: string | null,
  subagentId: string | null,
  projectPath?: string,
): SubagentMessagesResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sessionId || !subagentId) {
      setMessages([]);
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
        setMessages(normalizedToChatMessages(normalized));
        setIsLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [sessionId, subagentId, projectPath]);

  return { messages, isLoading, error };
}

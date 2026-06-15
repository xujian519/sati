import { useMemo } from 'react';
import { CheckCircle2, Loader2, XCircle, Bot } from 'lucide-react';
import type { ChatMessage } from '../chat/types/types';

function parseToolInput(toolInput: unknown): Record<string, unknown> {
  if (typeof toolInput === 'string') {
    try { return JSON.parse(toolInput); } catch { return {}; }
  }
  return (toolInput as Record<string, unknown>) || {};
}

function getCompactToolDisplay(toolName: string, toolInput: unknown): string {
  const input = parseToolInput(toolInput);
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'ApplyPatch':
      return (input.file_path as string)?.split('/').pop() || (input.file_path as string) || '';
    case 'Grep':
    case 'Glob':
      return (input.pattern as string) || '';
    case 'Bash': {
      const cmd = (input.command as string) || '';
      return cmd.length > 40 ? `${cmd.slice(0, 40)}...` : cmd;
    }
    default:
      return '';
  }
}

interface SubagentCardProps {
  message: ChatMessage;
  liveActivity?: ChatMessage;
  onOpenDetail?: (subagentId: string) => void;
}

export default function SubagentCard({ message, liveActivity, onOpenDetail }: SubagentCardProps) {
  const parsed = useMemo(() => parseToolInput(message.toolInput), [message.toolInput]);

  const subagentType = (parsed.subagent_type || parsed.subagentType || 'agent') as string;
  const description = (parsed.description || 'Running task') as string;
  const childTools = message.subagentState?.childTools ?? [];
  const isComplete = message.subagentState?.isComplete ?? false;
  const isFailed = Boolean(message.subagentState?.isFailed || message.toolResult?.isError);
  const currentToolIndex = message.subagentState?.currentToolIndex ?? -1;
  const currentTool = currentToolIndex >= 0 ? childTools[currentToolIndex] : null;
  const subagentId = (message as Record<string, unknown>).subagentId as string | undefined;

  const statusLine = useMemo(() => {
    if (liveActivity) {
      const state = String(liveActivity.state || 'running');
      const text = liveActivity.detail || liveActivity.title || liveActivity.content || 'Subagent running';
      if (state === 'failed') {
        return { icon: 'failed' as const, text: text || 'Failed' };
      }
      if (state === 'completed' || state === 'cancelled') {
        return { icon: 'completed' as const, text: text || 'Completed' };
      }
      return { icon: 'running' as const, text: text || 'Subagent running' };
    }
    if (isComplete && isFailed) {
      return { icon: 'failed' as const, text: `Failed (${childTools.length} tool${childTools.length !== 1 ? 's' : ''})` };
    }
    if (isComplete) {
      return { icon: 'completed' as const, text: `Completed (${childTools.length} tool${childTools.length !== 1 ? 's' : ''})` };
    }
    if (currentTool) {
      const detail = getCompactToolDisplay(currentTool.toolName, currentTool.toolInput);
      return { icon: 'running' as const, text: detail ? `${currentTool.toolName} / ${detail}` : currentTool.toolName };
    }
    return { icon: 'running' as const, text: 'Thinking...' };
  }, [isComplete, isFailed, childTools.length, currentTool, liveActivity]);

  const handleClick = () => {
    if (subagentId && onOpenDetail) {
      onOpenDetail(subagentId);
    }
  };

  const isClickable = Boolean(subagentId && onOpenDetail);

  return (
    <div
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable ? handleClick : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); } : undefined}
      className={`flex items-stretch gap-0 rounded-lg border border-neutral-200 dark:border-neutral-700 ${
        isClickable
          ? 'cursor-pointer transition-shadow hover:shadow-md hover:border-purple-300 dark:hover:border-purple-600'
          : ''
      }`}
    >
      {/* Purple left accent bar */}
      <div className="w-1 shrink-0 rounded-l-lg bg-purple-500 dark:bg-purple-400" />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2">
        {/* Line 1: type badge + description */}
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-3.5 w-3.5 shrink-0 text-purple-500 dark:text-purple-400" strokeWidth={1.8} />
          <span className="shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none text-purple-600 dark:bg-purple-900/40 dark:text-purple-300">
            {subagentType}
          </span>
          <span className="truncate text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
            {description}
          </span>
        </div>

        {/* Line 2: status */}
        <div className="flex min-w-0 items-center gap-1.5 pl-[22px] text-xs">
          {statusLine.icon === 'running' && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-purple-500 dark:text-purple-400" strokeWidth={2} />
          )}
          {statusLine.icon === 'completed' && (
            <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500 dark:text-green-400" strokeWidth={2} />
          )}
          {statusLine.icon === 'failed' && (
            <XCircle className="h-3 w-3 shrink-0 text-red-500 dark:text-red-400" strokeWidth={2} />
          )}
          <span className={`truncate ${
            statusLine.icon === 'running'
              ? 'text-neutral-500 dark:text-neutral-400'
              : statusLine.icon === 'completed'
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
          }`}>
            {statusLine.text}
          </span>
        </div>
      </div>
    </div>
  );
}

import React, { useMemo, useState } from 'react';
import { CheckCircle2, ClipboardList, MessageSquareText } from 'lucide-react';
import type { PermissionPanelProps } from '../../configs/permissionPanelRegistry';
import { MarkdownContent } from '../ContentRenderers/MarkdownContent';

function normalizePlanText(text: string): string {
  return text.replace(/\\n/g, '\n').trim();
}

function stringifyPlanCandidate(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = normalizePlanText(value);
    return normalized || null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => stringifyPlanCandidate(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['plan', 'planContent', 'content', 'markdown', 'text', 'body']) {
    const candidate = stringifyPlanCandidate(record[key]);
    if (candidate) return candidate;
  }

  return null;
}

export function extractPlanMarkdown(input: unknown): string {
  const plan = stringifyPlanCandidate(input);
  if (plan) return plan;

  if (input === undefined || input === null) {
    return '计划正文正在同步，请确认是否执行。';
  }

  if (typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    const onlyPermissionHints = keys.length === 0 || keys.every((key) => (
      key === 'allowedPrompts' ||
      key === 'planFilePath'
    ));
    if (onlyPermissionHints) {
      return '计划正文正在同步，请确认是否执行。';
    }
  }

  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export const ExitPlanModePanel: React.FC<PermissionPanelProps> = ({
  request,
  onDecision,
  onPlanExecutionApproved,
}) => {
  const [feedback, setFeedback] = useState('');
  const plan = useMemo(() => extractPlanMarkdown(request.input), [request.input]);

  const handleExecute = () => {
    onPlanExecutionApproved?.();
    onDecision(request.requestId, { allow: true });
  };

  const handleContinuePlanning = () => {
    const trimmed = feedback.trim();
    onDecision(request.requestId, {
      allow: false,
      message: trimmed
        ? `User wants to continue planning before implementation. Feedback:\n${trimmed}`
        : 'User wants to continue planning before implementation. Keep refining the plan instead of executing it.',
    });
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-lg dark:border-blue-900/70 dark:bg-neutral-900">
      <div className="border-b border-blue-100 bg-blue-50/70 px-4 py-3 dark:border-blue-900/70 dark:bg-blue-950/25">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
            <ClipboardList className="h-4 w-4" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
              计划已准备好
            </div>
            <div className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
              确认后会退出 Plan 模式，并让模型开始按计划执行。
            </div>
          </div>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto px-4 py-3">
        <MarkdownContent
          content={plan}
          className="prose prose-sm max-w-none text-neutral-800 dark:prose-invert dark:text-neutral-200"
        />
      </div>

      <div className="border-t border-neutral-100 bg-neutral-50/70 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950/40">
        <label className="mb-2 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
          继续讨论时可以补充说明
        </label>
        <textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={2}
          placeholder="例如：再补充测试方案，或者先不要改数据库。"
          className="block w-full resize-none rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-blue-700 dark:focus:ring-blue-950"
        />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={handleContinuePlanning}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            <MessageSquareText className="h-3.5 w-3.5" strokeWidth={2} />
            继续完善
          </button>
          <button
            type="button"
            onClick={handleExecute}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
          >
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
            执行计划
          </button>
        </div>
      </div>
    </div>
  );
};

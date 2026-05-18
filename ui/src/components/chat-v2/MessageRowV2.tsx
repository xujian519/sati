import { memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FileText } from 'lucide-react';
import type {
  ChatMessage,
  PilotDeckPermissionSuggestion,
  PermissionGrantResult,
} from '../chat/types/types';
import type { Project, SessionProvider } from '../../types/app';
import MessageComponent from '../chat/view/subcomponents/MessageComponent';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { formatUsageLimitText } from '../chat/utils/chatFormatting';
import {
  ProcessTrace,
  type ProcessTraceMetric,
  type ProcessTraceStep,
} from './ProcessTrace';
import { formatProcessDuration } from './processTraceUtils';

type DiffLine = { type: string; content: string; lineNum: number };

const getAttachmentTypeLabel = (name?: string, mimeType?: string): string => {
  const ext = String(name || '').split('.').pop()?.toUpperCase();
  if (ext && ext !== String(name || '').toUpperCase()) return ext;
  if (mimeType?.includes('/')) return mimeType.split('/').pop()?.toUpperCase() || 'FILE';
  return 'FILE';
};

const getAttachmentAccent = (name?: string, mimeType?: string): string => {
  const label = getAttachmentTypeLabel(name, mimeType).toLowerCase();
  if (label === 'pdf') return 'bg-red-500 text-white';
  if (label === 'doc' || label === 'docx') return 'bg-blue-500 text-white';
  if (label === 'xls' || label === 'xlsx' || label === 'csv') return 'bg-emerald-500 text-white';
  if (label === 'ppt' || label === 'pptx') return 'bg-orange-500 text-white';
  return 'bg-neutral-500 text-white';
};

type MessageRowV2Props = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  processSummary?: ChatMessage | null;
  processDetailMessages?: ChatMessage[];
  provider: SessionProvider;
  selectedProject: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (
    suggestion: PilotDeckPermissionSuggestion,
  ) => PermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
};

const shouldDelegate = (message: ChatMessage): boolean => {
  if (message.isToolUse) return true;
  if (message.isInteractivePrompt) return true;
  if (message.isSubagentContainer) return true;
  if (message.isTaskNotification) return true;
  const t = message.type;
  if (t !== 'user' && t !== 'assistant' && t !== 'error') return true;
  if (t === 'assistant' && message.isThinking && !message.content) return true;
  return false;
};

function MessageRowV2({
  message,
  prevMessage,
  processSummary,
  processDetailMessages = [],
  provider,
  selectedProject,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  autoExpandTools,
  showRawParameters,
  showThinking,
}: MessageRowV2Props) {
  const { t } = useTranslation('chat');
  const delegate = useMemo(() => shouldDelegate(message), [message]);

  const formattedContent = useMemo(
    () => formatUsageLimitText(String(message.content ?? '')),
    [message.content],
  );
  const messageImages = useMemo(
    () =>
      Array.isArray(message.images)
        ? message.images.filter((image) => image && typeof image.data === 'string')
        : [],
    [message.images],
  );
  const messageAttachments = useMemo(
    () =>
      Array.isArray(message.attachments)
        ? message.attachments.filter((attachment) => attachment && typeof attachment.name === 'string')
        : [],
    [message.attachments],
  );

  if (message.isAgentActivitySummary) {
    return <ProcessSummaryRow message={message} t={t} />;
  }

  const rowProcessSummary = processSummary ? (
    <ProcessSummaryRow
      message={processSummary}
      detailMessages={processDetailMessages}
      renderDetailMessage={(detailMessage, index) => (
        <MessageRowV2
          key={detailMessage.id || `${processSummary.id || 'process-detail'}-${index}`}
          message={detailMessage}
          prevMessage={index > 0 ? processDetailMessages[index - 1] : null}
          provider={provider}
          selectedProject={selectedProject}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={onGrantToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
        />
      )}
      t={t}
    />
  ) : null;

  if (delegate) {
    return (
      <>
        {rowProcessSummary}
        <div className="ui-v2-legacy-row">
          <MessageComponent
            message={message}
            prevMessage={prevMessage}
            createDiff={createDiff}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantSessionToolPermission={onGrantToolPermission}
            autoExpandTools={autoExpandTools}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject ?? null}
            provider={provider}
            hideHeader
          />
        </div>
      </>
    );
  }

  const isUser = message.type === 'user';
  const isError = message.type === 'error';

  if (isUser) {
    return (
      <div className="flex w-full justify-end">
        <div className="min-w-0 max-w-[78%] overflow-hidden rounded-[22px] bg-neutral-100 px-4 py-2.5 text-[14px] leading-relaxed text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
          {message.isStreaming && !formattedContent ? (
            <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 dark:bg-neutral-500" />
          ) : (
            <>
              {messageAttachments.length > 0 ? (
                <div className={formattedContent ? 'mb-2 grid grid-cols-1 gap-2' : 'grid grid-cols-1 gap-2'}>
                  {messageAttachments.map((attachment, index) => (
                    <div
                      key={`${attachment.name || 'attachment'}-${index}`}
                      className="flex min-w-0 items-center gap-3 rounded-2xl bg-white/85 p-2.5 pr-3 dark:bg-neutral-900/45"
                    >
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${getAttachmentAccent(attachment.name, attachment.mimeType)}`}>
                        <FileText className="h-5 w-5" strokeWidth={2} />
                      </div>
                      <div className="min-w-0 text-left">
                        <div className="truncate text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                          {attachment.name}
                        </div>
                        <div className="mt-0.5 text-[11px] font-medium uppercase text-neutral-500 dark:text-neutral-400">
                          {getAttachmentTypeLabel(attachment.name, attachment.mimeType)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {messageImages.length > 0 ? (
                <div className={formattedContent ? 'mb-2 grid grid-cols-1 gap-2' : 'grid grid-cols-1 gap-2'}>
                  {messageImages.map((image, index) => (
                    <div
                      key={`${image.name || 'image'}-${index}`}
                      className="block w-72 max-w-full overflow-hidden rounded-xl border border-neutral-200 bg-white/70 dark:border-neutral-700 dark:bg-neutral-900/40"
                    >
                      <img
                        src={image.data}
                        alt={image.name || 'Uploaded image'}
                        className="block h-auto max-h-64 w-full object-contain"
                        loading="lazy"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              {formattedContent ? (
                <Markdown className="min-w-0 break-words [overflow-wrap:anywhere]">{formattedContent}</Markdown>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
          <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1 pt-0.5 text-[14px] leading-relaxed text-red-500">
          <Markdown>{formattedContent}</Markdown>
        </div>
      </div>
    );
  }

  return (
    <>
      {rowProcessSummary}
      <div className="min-w-0 text-[14px] leading-relaxed text-neutral-900 dark:text-neutral-100">
        {message.isStreaming && !formattedContent ? (
          <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 dark:bg-neutral-500" />
        ) : (
          <Markdown>{formattedContent}</Markdown>
        )}
      </div>
    </>
  );
}

export default memo(MessageRowV2);

function normalizeKeySteps(value: unknown): ProcessTraceStep[] {
  return Array.isArray(value)
    ? value
        .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object')
        .map((step) => ({
          id: typeof step.activityId === 'string' ? step.activityId : undefined,
          title: typeof step.title === 'string' ? step.title : undefined,
          detail: typeof step.detail === 'string' ? step.detail : undefined,
          state: typeof step.state === 'string' ? step.state : undefined,
          severity: typeof step.severity === 'string' ? step.severity : undefined,
          phase: typeof step.phase === 'string' ? step.phase : undefined,
          toolName: typeof step.toolName === 'string' ? step.toolName : undefined,
        }))
    : [];
}

function ProcessSummaryRow({
  message,
  detailMessages = [],
  renderDetailMessage,
  t,
}: {
  message: ChatMessage;
  detailMessages?: ChatMessage[];
  renderDetailMessage?: (message: ChatMessage, index: number) => ReactNode;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const steps = useMemo(() => normalizeKeySteps(message.keySteps), [message.keySteps]);
  const status = String(message.state || 'completed');
  const isFailed = status === 'failed';
  const isCancelled = status === 'cancelled';
  const title = isFailed
    ? t('process.summary.failed', { defaultValue: 'Process failed' })
    : isCancelled
      ? t('process.summary.cancelled', { defaultValue: 'Process stopped' })
      : t('process.summary.completed', { defaultValue: 'Process completed' });
  const toolCalls = Number(message.toolCallCount || 0);
  const searches = Number(message.ragSearchCount || 0);
  const errors = Number(message.toolErrorCount || 0);
  const duration = formatProcessDuration(message.durationMs as number | null | undefined);
  const collapsedLabel = t('process.summary.processed', {
    duration,
    defaultValue: `Processed ${duration}`,
  });
  const metrics: ProcessTraceMetric[] = [
    toolCalls > 0
      ? {
          key: 'toolCalls',
          label: t('process.metrics.toolCalls', { count: toolCalls, defaultValue: '{{count}} tool calls' }),
        }
      : null,
    searches > 0
      ? {
          key: 'searches',
          label: t('process.metrics.searches', { count: searches, defaultValue: '{{count}} searches' }),
        }
      : null,
    errors > 0
      ? {
          key: 'errors',
          label: t('process.metrics.errors', { count: errors, defaultValue: '{{count}} errors' }),
        }
      : null,
  ].filter((metric): metric is ProcessTraceMetric => Boolean(metric));
  const fallbackSteps: ProcessTraceStep[] =
    steps.length > 0
      ? steps
      : [
          {
            id: `${message.id || 'process'}-empty`,
            title: t('process.noSteps', { defaultValue: 'No detailed steps recorded.' }),
            state: status,
          },
        ];

  return (
    <ProcessTrace
      label={collapsedLabel}
      statusLabel={title}
      status={status}
      metrics={metrics}
      steps={detailMessages.length > 0 && renderDetailMessage ? [] : fallbackSteps}
    >
      {detailMessages.length > 0 && renderDetailMessage
        ? detailMessages.map((detailMessage, index) =>
            renderDetailMessage(detailMessage, index),
          )
        : null}
    </ProcessTrace>
  );
}

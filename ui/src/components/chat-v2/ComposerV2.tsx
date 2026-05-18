import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import {
  ArrowUp,
  AtSign,
  Bot,
  Check,
  ChevronDown,
  CircleGauge,
  Command,
  Hand,
  ListChecks,
  Loader2,
  Paperclip,
  ShieldAlert,
  Square,
  type LucideIcon,
} from 'lucide-react';
import type { ChatRunMode, PendingPermissionRequest, PermissionMode } from '../chat/types/types';
import CommandMenu from '../chat/view/subcomponents/CommandMenu';
import PermissionRequestsBanner from '../chat/view/subcomponents/PermissionRequestsBanner';
import ImageAttachment from '../chat/view/subcomponents/ImageAttachment';
import { cn } from '../../lib/utils.js';

type PermissionModeOption = {
  mode: PermissionMode;
  Icon: LucideIcon;
  labelKey: string;
  defaultLabel: string;
  descriptionKey: string;
  defaultDescription: string;
};

const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    mode: 'default',
    Icon: Hand,
    labelKey: 'input.permissions.default',
    defaultLabel: 'Default',
    descriptionKey: 'input.permissions.defaultDescription',
    defaultDescription: 'Ask before risky operations',
  },
  {
    mode: 'bypassPermissions',
    Icon: ShieldAlert,
    labelKey: 'input.permissions.bypassPermissions',
    defaultLabel: 'Full Access',
    descriptionKey: 'input.permissions.bypassPermissionsDescription',
    defaultDescription: 'Skip confirmations and allow full access',
  },
];

type RunModeOption = {
  mode: ChatRunMode;
  Icon: LucideIcon;
  labelKey: string;
  defaultLabel: string;
};

const RUN_MODE_OPTIONS: RunModeOption[] = [
  {
    mode: 'agent',
    Icon: Bot,
    labelKey: 'input.runModes.agent',
    defaultLabel: 'Agent',
  },
  {
    mode: 'plan',
    Icon: ListChecks,
    labelKey: 'input.runModes.plan',
    defaultLabel: 'Plan',
  },
];

const BLOCKING_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'ask_user_question',
  'ExitPlanMode',
  'ExitPlanModeV2',
  'exit_plan_mode',
]);

const DEFAULT_CONTEXT_WINDOW = (() => {
  const parsed = Number(import.meta.env.VITE_CONTEXT_WINDOW);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 160000;
})();

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
}

type ContextStatus = {
  known: boolean;
  used: number;
  total: number;
  percent: number;
  usedLabel: string;
  totalLabel: string;
  tone: 'normal' | 'amber' | 'red' | 'unknown';
};

function getContextStatus(tokenBudget?: Record<string, unknown> | null): ContextStatus {
  const used = readNumber(tokenBudget?.used) ?? 0;
  const total = readNumber(tokenBudget?.total) ?? DEFAULT_CONTEXT_WINDOW;
  if (total <= 0) {
    return {
      known: false, used: 0, total: 0, percent: 0,
      usedLabel: '--', totalLabel: '--', tone: 'unknown',
    };
  }
  const percent = Math.max(0, Math.min(999, Math.round((used / total) * 100)));
  const snapshotState = typeof tokenBudget?.state === 'string' ? tokenBudget.state : null;
  const tone = snapshotState === 'blocking'
    ? 'red'
    : snapshotState === 'warning'
      ? 'amber'
      : percent >= 95
        ? 'red'
        : percent >= 80
          ? 'amber'
          : 'normal';
  return {
    known: true, used, total, percent,
    usedLabel: formatTokenCount(used),
    totalLabel: formatTokenCount(total),
    tone,
  };
}

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ComposerV2Props = {
  input: string;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSubmit: (
    event:
      | FormEvent<HTMLFormElement>
      | MouseEvent<HTMLButtonElement>
      | TouchEvent<HTMLButtonElement>,
  ) => void;
  onAbortSession: () => void;
  openImagePicker: () => void;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;

  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;

  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];

  onToggleCommandMenu: () => void;
  onInsertMention: () => void;
  onInsertSlash: () => void;
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  isDragActive: boolean;

  isLoading: boolean;
  canAbortSession: boolean;
  isAborting: boolean;
  isSubmitPending?: boolean;
  tokenBudget?: Record<string, unknown> | null;

  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: {
      allow?: boolean;
      message?: string;
      rememberEntry?: string | null;
      updatedInput?: unknown;
    },
  ) => void;
  handleGrantToolPermission: (suggestion: {
    entry: string;
    toolName: string;
  }) => { success: boolean };

  sendByCtrlEnter?: boolean;

  permissionMode: PermissionMode;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  runMode: ChatRunMode;
  onRunModeChange: (mode: ChatRunMode) => void;
  planModeAvailable?: boolean;
  onPlanExecutionApproved?: () => void;

  /**
   * When true, the outer "footer" chrome (top divider, page bg, page padding)
   * is suppressed so this composer can be embedded inside a centered card —
   * notably the Agent welcome state. The inner rounded textarea card is the
   * only border in that mode, avoiding the doubled-divider artifact.
   */
  chromeless?: boolean;
};

export default function ComposerV2({
  input,
  placeholder,
  textareaRef,
  inputHighlightRef,
  renderInputWithMentions,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  onSubmit,
  onAbortSession,
  openImagePicker,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  onToggleCommandMenu: _onToggleCommandMenu,
  onInsertMention,
  onInsertSlash,
  getRootProps,
  getInputProps,
  isDragActive,
  isLoading,
  canAbortSession,
  isAborting,
  isSubmitPending = false,
  tokenBudget,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  permissionMode,
  onSelectPermissionMode,
  runMode,
  onRunModeChange,
  planModeAvailable = true,
  onPlanExecutionApproved,
  chromeless = false,
}: ComposerV2Props) {
  const { t } = useTranslation('chat');
  const [isContextPopoverOpen, setIsContextPopoverOpen] = useState(false);
  const [isRunModeMenuOpen, setIsRunModeMenuOpen] = useState(false);
  const [isPermissionMenuOpen, setIsPermissionMenuOpen] = useState(false);

  const hasBlockingPermissionPanel = pendingPermissionRequests.some(
    (r) => BLOCKING_PERMISSION_TOOLS.has(r.toolName),
  );

  const textareaRect = textareaRef.current?.getBoundingClientRect();
  const commandMenuPosition = {
    top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
    left: textareaRect ? textareaRect.left : 16,
    bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
  };

  const disabled = isLoading || isSubmitPending || !input.trim();
  const contextStatus = getContextStatus(tokenBudget);

  const selectedPermissionOption =
    PERMISSION_MODE_OPTIONS.find((o) => o.mode === permissionMode) || PERMISSION_MODE_OPTIONS[0];
  const selectedRunModeOption =
    RUN_MODE_OPTIONS.find((o) => o.mode === runMode) || RUN_MODE_OPTIONS[0];
  const SelectedRunModeIcon = selectedRunModeOption.Icon;
  const selectedRunModeLabel = t(selectedRunModeOption.labelKey, { defaultValue: selectedRunModeOption.defaultLabel }) as string;
  const SelectedPermissionIcon = selectedPermissionOption.Icon;
  const selectedPermissionLabel = t(selectedPermissionOption.labelKey, { defaultValue: selectedPermissionOption.defaultLabel }) as string;
  const contextStatusTitle = contextStatus.known
    ? `${contextStatus.percent}% of the current context window is occupied. ${contextStatus.usedLabel} tokens out of ${contextStatus.totalLabel}.`
    : 'Current context usage unavailable.';

  return (
    <div
      className={cn(
        'shrink-0',
        // No top divider — the rounded textarea card is the only border, giving
        // the composer a flat ChatGPT-style look. Keeps page bg + padding so
        // it still anchors the bottom of the chat surface.
        chromeless ? '' : 'bg-white px-6 pb-6 pt-3 dark:bg-neutral-950',
      )}
    >
      <div className={cn(chromeless ? '' : 'mx-auto max-w-[720px]')}>
        {pendingPermissionRequests.length > 0 ? (
          <div className="mb-3">
            <PermissionRequestsBanner
              pendingPermissionRequests={pendingPermissionRequests}
              handlePermissionDecision={handlePermissionDecision}
              handleGrantToolPermission={handleGrantToolPermission}
              onPlanExecutionApproved={onPlanExecutionApproved}
            />
          </div>
        ) : null}

        {!hasBlockingPermissionPanel ? (
          <form
            onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
            className="relative"
          >
            {attachedImages.length > 0 ? (
              <div className="mb-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {showFileDropdown && filteredFiles.length > 0 ? (
              <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                {filteredFiles.map((file, index) => (
                  <div
                    key={file.path}
                    className={cn(
                      'cursor-pointer border-b border-neutral-100 px-3 py-2 text-[13px] last:border-b-0 dark:border-neutral-800',
                      index === selectedFileIndex
                        ? 'bg-neutral-100 dark:bg-neutral-800'
                        : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectFile(file);
                    }}
                  >
                    <div className="font-medium">{file.name}</div>
                    <div className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                      {file.path}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <CommandMenu
              commands={filteredCommands}
              selectedIndex={selectedCommandIndex}
              onSelect={onCommandSelect}
              onClose={onCloseCommandMenu}
              position={commandMenuPosition}
              isOpen={isCommandMenuOpen}
              frequentCommands={frequentCommands}
            />

            <div
              {...getRootProps()}
              className={cn(
                'group rounded-xl border bg-white p-2 shadow-sm transition-colors',
                'border-neutral-200 focus-within:border-neutral-300',
                'dark:border-neutral-800 dark:bg-neutral-900 dark:focus-within:border-neutral-700',
                isDragActive && 'border-dashed border-neutral-400 dark:border-neutral-500',
              )}
            >
              <input {...getInputProps()} />

              <div className="relative">
                <div
                  ref={inputHighlightRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden"
                >
                  <div className="block w-full whitespace-pre-wrap break-words px-2 pt-1.5 text-[14px] leading-6 text-transparent">
                    {renderInputWithMentions(input)}
                  </div>
                </div>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={onInputChange}
                  onClick={onTextareaClick}
                  onKeyDown={onTextareaKeyDown}
                  onPaste={onTextareaPaste}
                  onScroll={(event) =>
                    onTextareaScrollSync(event.target as HTMLTextAreaElement)
                  }
                  onFocus={() => onInputFocusChange?.(true)}
                  onBlur={() => onInputFocusChange?.(false)}
                  onInput={onTextareaInput}
                  placeholder={placeholder}
                  rows={2}
                  className="relative z-10 block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-2 pt-1.5 text-[14px] leading-6 text-neutral-900 placeholder-neutral-400 outline-none dark:text-neutral-100 dark:placeholder-neutral-500"
                />
              </div>

              <div className="flex items-center justify-between px-1 pt-1">
                <div className="flex min-w-0 items-center gap-0.5">
                  {/* Run mode selector */}
                  <div
                    className="relative mr-1"
                    onBlur={(event) => {
                      const next = event.relatedTarget as Node | null;
                      if (!next || !event.currentTarget.contains(next)) setIsRunModeMenuOpen(false);
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setIsRunModeMenuOpen((o) => !o)}
                      className={cn(
                        'inline-flex h-7 max-w-[108px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[140px]',
                        runMode === 'plan'
                          ? 'text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/30'
                          : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                      )}
                      title={t('input.runModes.change', { defaultValue: 'Select run mode' }) as string}
                      aria-haspopup="menu"
                      aria-expanded={isRunModeMenuOpen}
                    >
                      <SelectedRunModeIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                      <span className="truncate">{selectedRunModeLabel}</span>
                      <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', isRunModeMenuOpen && 'rotate-180')} strokeWidth={2} />
                    </button>
                    {isRunModeMenuOpen ? (
                      <div role="menu" className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                        {RUN_MODE_OPTIONS.map((option) => {
                          const Icon = option.Icon;
                          const isSelected = runMode === option.mode;
                          const isPlan = option.mode === 'plan';
                          const isDisabled = isPlan && !planModeAvailable;
                          const label = t(option.labelKey, { defaultValue: option.defaultLabel }) as string;
                          const description = isPlan ? 'Plan first, then execute' : 'Handle and execute directly';
                          return (
                            <button
                              key={option.mode}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              disabled={isDisabled}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { if (!isDisabled) { onRunModeChange(option.mode); setIsRunModeMenuOpen(false); } }}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                                isSelected ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/70',
                              )}
                            >
                              <Icon className={cn('h-4 w-4 shrink-0', isPlan ? 'text-blue-600 dark:text-blue-300' : 'text-neutral-500 dark:text-neutral-400')} strokeWidth={1.9} />
                              <span className="min-w-0 flex-1">
                                <span className={cn('block truncate text-[13px] font-medium', isPlan ? 'text-blue-700 dark:text-blue-300' : 'text-neutral-900 dark:text-neutral-100')}>{label}</span>
                                <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">{description}</span>
                              </span>
                              {isSelected ? <Check className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" strokeWidth={2} /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={openImagePicker}
                    disabled={isLoading}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.attachFiles', { defaultValue: 'Attach files' }) as string}
                  >
                    <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={onInsertMention}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.mentionFile', { defaultValue: 'Mention a file' }) as string}
                  >
                    <AtSign className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={onInsertSlash}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.slashCommand', { defaultValue: 'Run a command' }) as string}
                  >
                    <Command className="h-4 w-4" strokeWidth={1.75} />
                  </button>

                  {/* Permission mode selector */}
                  <div
                    className="relative"
                    onBlur={(event) => {
                      const next = event.relatedTarget as Node | null;
                      if (!next || !event.currentTarget.contains(next)) setIsPermissionMenuOpen(false);
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setIsPermissionMenuOpen((o) => !o)}
                      className={cn(
                        'inline-flex h-7 max-w-[132px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[190px]',
                        permissionMode === 'bypassPermissions'
                          ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
                          : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                      )}
                      title={t('input.permissions.change', { defaultValue: 'Select permission mode' }) as string}
                      aria-haspopup="menu"
                      aria-expanded={isPermissionMenuOpen}
                    >
                      <SelectedPermissionIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                      <span className="truncate">{selectedPermissionLabel}</span>
                      <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', isPermissionMenuOpen && 'rotate-180')} strokeWidth={2} />
                    </button>
                    {isPermissionMenuOpen ? (
                      <div role="menu" className="absolute bottom-full left-0 z-50 mb-2 w-60 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                        {PERMISSION_MODE_OPTIONS.map((option) => {
                          const Icon = option.Icon;
                          const isSelected = permissionMode === option.mode;
                          const isDangerous = option.mode === 'bypassPermissions';
                          const label = t(option.labelKey, { defaultValue: option.defaultLabel }) as string;
                          const description = t(option.descriptionKey, { defaultValue: option.defaultDescription }) as string;
                          return (
                            <button
                              key={option.mode}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { onSelectPermissionMode(option.mode); setIsPermissionMenuOpen(false); }}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                                isSelected ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/70',
                              )}
                            >
                              <Icon className={cn('h-4 w-4 shrink-0', isDangerous ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-500 dark:text-neutral-400')} strokeWidth={1.9} />
                              <span className="min-w-0 flex-1">
                                <span className={cn('block truncate text-[13px] font-medium', isDangerous ? 'text-amber-700 dark:text-amber-300' : 'text-neutral-900 dark:text-neutral-100')}>{label}</span>
                                <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">{description}</span>
                              </span>
                              {isSelected ? <Check className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" strokeWidth={2} /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="ml-2 flex shrink-0 items-center gap-1">
                  {/* Context window status */}
                  <div
                    className="relative"
                    onBlur={(event) => {
                      const next = event.relatedTarget as Node | null;
                      if (!next || !event.currentTarget.contains(next)) setIsContextPopoverOpen(false);
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setIsContextPopoverOpen((o) => !o)}
                      className={cn(
                        'inline-flex h-7 min-w-[44px] items-center justify-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition',
                        contextStatus.tone === 'red'
                          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
                          : contextStatus.tone === 'amber'
                            ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
                            : contextStatus.tone === 'normal'
                              ? 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                              : 'text-neutral-400 hover:bg-neutral-100 dark:text-neutral-500 dark:hover:bg-neutral-800',
                      )}
                      title={contextStatusTitle}
                      aria-label={contextStatusTitle}
                      aria-expanded={isContextPopoverOpen}
                    >
                      <CircleGauge className="h-4 w-4" strokeWidth={1.75} />
                      <span>{contextStatus.known ? `${contextStatus.percent}%` : '--'}</span>
                    </button>
                    {isContextPopoverOpen ? (
                      <div
                        role="status"
                        className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-lg border border-neutral-200 bg-white p-3 text-left text-[12px] leading-5 text-neutral-700 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="font-medium text-neutral-900 dark:text-neutral-100">Context window</span>
                          <span className={cn(
                            'rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
                            contextStatus.tone === 'red' ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                              : contextStatus.tone === 'amber' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                              : contextStatus.tone === 'normal' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                              : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                          )}>
                            {contextStatus.known ? `${contextStatus.percent}%` : '--'}
                          </span>
                        </div>
                        {contextStatus.known ? (
                          <>
                            <div className="text-neutral-500 dark:text-neutral-400">
                              Current context estimate: {contextStatus.used.toLocaleString()} tokens out of {contextStatus.total.toLocaleString()}.
                            </div>
                            <div className="mt-2 text-neutral-500 dark:text-neutral-400">
                              Auto compact runs when the conversation approaches the configured limit.
                            </div>
                          </>
                        ) : (
                          <div className="text-neutral-500 dark:text-neutral-400">
                            No token budget has been reported yet. It will appear after the next model response.
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>

                  {isLoading && canAbortSession ? (
                    <button
                      type="button"
                      onClick={onAbortSession}
                      disabled={isAborting}
                      className={cn(
                        'inline-flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white transition hover:bg-red-600',
                        isAborting && 'cursor-wait opacity-70 hover:bg-red-500',
                      )}
                      title={isAborting ? 'Stopping...' : 'Stop'}
                    >
                      {isAborting ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                      ) : (
                        <Square className="h-3.5 w-3.5" strokeWidth={2.5} fill="currentColor" />
                      )}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={disabled}
                      aria-busy={isSubmitPending}
                      onMouseDown={(event) => {
                        if (disabled) return;
                        event.preventDefault();
                        onSubmit(event);
                      }}
                      onTouchStart={(event) => {
                        if (disabled) return;
                        event.preventDefault();
                        onSubmit(event);
                      }}
                      className={cn(
                        'inline-flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white transition hover:opacity-90 disabled:opacity-40 dark:bg-neutral-50 dark:text-neutral-900',
                        isSubmitPending && 'cursor-wait',
                      )}
                      title={isSubmitPending ? 'Sending...' : 'Send'}
                    >
                      {isSubmitPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                      ) : (
                        <ArrowUp className="h-4 w-4" strokeWidth={2} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

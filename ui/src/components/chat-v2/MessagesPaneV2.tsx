import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { XCircle } from 'lucide-react';
import type {
  ChatMessage,
  ChatRunMode,
  ClaudeWorkStatus,
  PilotDeckPermissionSuggestion,
  PermissionGrantResult,
} from '../chat/types/types';
import { isBackgroundTaskSession, type Project, type ProjectSession, type SessionProvider } from '../../types/app';
import { getIntrinsicMessageKey } from '../chat/utils/messageKeys';
import MessageRowV2 from './MessageRowV2';
import { ProcessLiveStatus, ProcessRunHeader, type ProcessTraceStep } from './ProcessTrace';
import { formatProcessDuration } from './processTraceUtils';

type DiffLine = { type: string; content: string; lineNum: number };

type MessagesPaneV2Props = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  sessionLoadError?: string | null;
  onRetrySessionLoad?: () => void;
  chatMessages: ChatMessage[];
  activityMessages?: ChatMessage[];
  visibleMessages: ChatMessage[];
  visibleMessageCount: number;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (
    suggestion: PilotDeckPermissionSuggestion,
  ) => PermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  isAssistantWorking?: boolean;
  workingStatus?: ClaudeWorkStatus | null;
  runMode?: ChatRunMode;
};

type RenderableMessageItem = {
  message: ChatMessage;
  originalIndex: number;
  processSummary?: ChatMessage | null;
  processDetailMessages?: ChatMessage[];
};

type KeyedRenderableMessageItem = RenderableMessageItem & {
  itemKey: string;
  renderIndex: number;
  estimatedHeight: number;
};

export type VirtualMessageWindow = {
  startIndex: number;
  endIndex: number;
  topPadding: number;
  bottomPadding: number;
  totalHeight: number;
};

type ActivitySummaryAttachment = {
  message: ChatMessage;
  originalIndex: number;
};

type MessageTurn = {
  start: number;
  end: number;
  summary: ActivitySummaryAttachment | null;
};

export type LiveProcessGroup = {
  id: string;
  afterOriginalIndex: number;
  beforeOriginalIndex: number | null;
  startIndex: number;
  endIndex: number;
  messages: ChatMessage[];
  detailMessages: ChatMessage[];
  isRunning: boolean;
};

type BuildRenderableMessageItemsOptions = {
  isAssistantWorking?: boolean;
};

const MESSAGE_VIRTUALIZATION_THRESHOLD = 160;
const MESSAGE_WINDOW_OVERSCAN = 12;
const MESSAGE_GAP_PX = 32;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getActivitySummaryKey(message: ChatMessage, index: number): string {
  return str(message.runId) || str(message.id) || `${str(message.startedAt)}-${str(message.endedAt)}-${index}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function getMessageTextLength(message: ChatMessage): number {
  const contentLength = typeof message.content === 'string' ? message.content.length : 0;
  const toolInputLength = typeof message.toolInput === 'string' ? message.toolInput.length : 0;
  const outputLength = typeof message.toolResult?.content === 'string' ? message.toolResult.content.length : 0;
  return contentLength + Math.min(toolInputLength + outputLength, 2400);
}

export function estimateMessageItemHeight(item: RenderableMessageItem): number {
  const textLength = getMessageTextLength(item.message);
  const roughLines = Math.ceil(textLength / 92);
  const baseHeight = item.message.type === 'user' ? 64 : 92;
  const processSummaryHeight = item.processSummary ? 58 : 0;
  const attachmentHeight = Array.isArray(item.message.attachments) && item.message.attachments.length > 0 ? 56 : 0;
  const imageHeight = Array.isArray(item.message.images) && item.message.images.length > 0 ? 180 : 0;
  const toolHeight = item.message.isToolUse || item.message.toolName ? 140 : 0;

  return clampNumber(
    baseHeight + roughLines * 20 + processSummaryHeight + attachmentHeight + imageHeight + toolHeight + MESSAGE_GAP_PX,
    72,
    720,
  );
}

export function getVirtualMessageWindow(
  itemHeights: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = MESSAGE_WINDOW_OVERSCAN,
): VirtualMessageWindow {
  if (itemHeights.length === 0) {
    return { startIndex: 0, endIndex: 0, topPadding: 0, bottomPadding: 0, totalHeight: 0 };
  }

  const prefixOffsets = [0];
  for (const height of itemHeights) {
    prefixOffsets.push(prefixOffsets[prefixOffsets.length - 1] + Math.max(1, height));
  }

  const totalHeight = prefixOffsets[prefixOffsets.length - 1];
  const safeScrollTop = clampNumber(Number.isFinite(scrollTop) ? scrollTop : 0, 0, totalHeight);
  const safeViewportHeight = Math.max(1, Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight
    : 900);
  const rawStart = Math.max(0, upperBound(prefixOffsets, safeScrollTop) - 1);
  const rawEnd = Math.min(itemHeights.length, upperBound(prefixOffsets, safeScrollTop + safeViewportHeight));
  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(itemHeights.length, Math.max(startIndex + 1, rawEnd + overscan));

  return {
    startIndex,
    endIndex,
    topPadding: prefixOffsets[startIndex],
    bottomPadding: Math.max(0, totalHeight - prefixOffsets[endIndex]),
    totalHeight,
  };
}

function canHostProcessSummary(message: ChatMessage): boolean {
  return (
    message.type === 'assistant' &&
    !message.isAgentActivitySummary &&
    !message.isAgentActivity &&
    !message.isToolUse &&
    !message.isInteractivePrompt &&
    !message.isSubagentContainer &&
    !message.isTaskNotification &&
    !message.isThinking &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  );
}

function isCollapsibleProcessMessage(message: ChatMessage): boolean {
  if (message.isAgentActivity || message.isAgentActivitySummary) {
    return false;
  }
  return message.type !== 'user';
}

const USER_VISIBLE_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'ExitPlanModeV2',
  'exit_plan_mode',
]);

function isLiveProcessMessage(message: ChatMessage): boolean {
  if (message.isAgentActivity || message.isAgentActivitySummary) {
    return false;
  }
  if (message.isInteractivePrompt || message.type === 'error') {
    return false;
  }
  if (message.isToolUse && USER_VISIBLE_TOOL_NAMES.has(String(message.toolName || ''))) {
    return false;
  }
  return Boolean(
    message.isToolUse ||
      message.isSubagentContainer ||
      message.isTaskNotification ||
      message.isCompactBoundary ||
      message.isThinking ||
      message.type === 'tool',
  );
}

function isExpandableLiveProcessMessage(message: ChatMessage): boolean {
  if (!message.isToolUse || message.isSubagentContainer) {
    return false;
  }
  const toolName = String(message.toolName || '');
  if (!toolName || toolName === 'Task' || USER_VISIBLE_TOOL_NAMES.has(toolName)) {
    return false;
  }
  return true;
}

function parseMessageTime(value: unknown): number | null {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function createMessageTurns(messages: ChatMessage[]): MessageTurn[] {
  if (messages.length === 0) {
    return [];
  }

  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (message.type === 'user') {
      starts.push(index);
    }
  });

  if (starts.length === 0 || starts[0] > 0) {
    starts.unshift(0);
  }

  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? messages.length,
    summary: null,
  }));
}

function findTurnIndexByPosition(turns: MessageTurn[], index: number): number {
  return turns.findIndex((turn) => index >= turn.start && index < turn.end);
}

function findTurnIndexByTime(messages: ChatMessage[], turns: MessageTurn[], timestamp: number): number {
  let matchedIndex = -1;

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const startMessage = messages[turns[turnIndex].start];
    if (startMessage?.type !== 'user') {
      continue;
    }

    const startTime = parseMessageTime(startMessage.timestamp);
    if (startTime == null) {
      continue;
    }

    if (startTime <= timestamp) {
      matchedIndex = turnIndex;
      continue;
    }

    if (startTime > timestamp) {
      break;
    }
  }

  return matchedIndex;
}

function getSummaryAnchorTime(summary: ChatMessage): number | null {
  return (
    parseMessageTime(summary.startedAt) ??
    parseMessageTime(summary.timestamp) ??
    parseMessageTime(summary.endedAt)
  );
}

function getSummarySortTime(summary: ChatMessage): number {
  return (
    parseMessageTime(summary.endedAt) ??
    parseMessageTime(summary.timestamp) ??
    parseMessageTime(summary.startedAt) ??
    0
  );
}

function isNewerSummary(
  next: ActivitySummaryAttachment,
  current: ActivitySummaryAttachment | null,
): boolean {
  if (!current) {
    return true;
  }
  const nextTime = getSummarySortTime(next.message);
  const currentTime = getSummarySortTime(current.message);
  if (nextTime !== currentTime) {
    return nextTime > currentTime;
  }
  return next.originalIndex > current.originalIndex;
}

function attachSummariesToTurns(messages: ChatMessage[], turns: MessageTurn[]): void {
  const summariesByKey = new Map<string, ActivitySummaryAttachment>();

  messages.forEach((message, originalIndex) => {
    if (message.isAgentActivitySummary) {
      summariesByKey.set(getActivitySummaryKey(message, originalIndex), { message, originalIndex });
    }
  });

  const summaries = Array.from(summariesByKey.values()).sort(
    (a, b) => a.originalIndex - b.originalIndex,
  );

  for (const summary of summaries) {
    const anchorTime = getSummaryAnchorTime(summary.message);
    const turnIndexFromTime = anchorTime == null ? -1 : findTurnIndexByTime(messages, turns, anchorTime);
    const turnIndex = turnIndexFromTime >= 0
      ? turnIndexFromTime
      : findTurnIndexByPosition(turns, summary.originalIndex);

    if (turnIndex < 0) {
      continue;
    }

    if (isNewerSummary(summary, turns[turnIndex].summary)) {
      turns[turnIndex].summary = summary;
    }
  }
}

function getTurnDurationMs(messages: ChatMessage[], turn: MessageTurn, hostIndex: number): number {
  let startTime: number | null = null;
  for (let index = turn.start; index <= hostIndex; index += 1) {
    startTime = parseMessageTime(messages[index]?.timestamp);
    if (startTime != null) {
      break;
    }
  }

  const endTime = parseMessageTime(messages[hostIndex]?.timestamp);
  if (startTime == null || endTime == null) {
    return 0;
  }
  return Math.max(0, endTime - startTime);
}

function createSyntheticProcessSummary(
  messages: ChatMessage[],
  turn: MessageTurn,
  hostIndex: number,
  detailMessages: ChatMessage[],
): ChatMessage {
  const host = messages[hostIndex];
  const startedAt = messages[turn.start]?.timestamp;
  const endedAt = host?.timestamp;
  const toolCallCount = detailMessages.filter((message) =>
    message.isToolUse || Boolean(message.toolName),
  ).length;
  const toolErrorCount = detailMessages.filter((message) =>
    message.toolResult?.isError || message.type === 'error',
  ).length;
  const ragSearchCount = detailMessages.filter((message) =>
    message.phase === 'rag' || /search|检索/i.test(`${message.toolName || ''} ${message.content || ''}`),
  ).length;

  return {
    id: `process_summary_${host?.id || hostIndex}`,
    type: 'system',
    content: 'Process summary',
    timestamp: endedAt || new Date().toISOString(),
    isAgentActivitySummary: true,
    startedAt: startedAt ? String(startedAt) : '',
    endedAt: endedAt ? String(endedAt) : '',
    durationMs: getTurnDurationMs(messages, turn, hostIndex),
    state: 'completed',
    toolCallCount,
    toolErrorCount,
    ragSearchCount,
    compactCount: detailMessages.filter((message) => message.isCompactBoundary).length,
    keySteps: [],
  };
}

export function buildRenderableMessageItems(
  messages: ChatMessage[],
  options: BuildRenderableMessageItemsOptions = {},
): RenderableMessageItem[] {
  const items: RenderableMessageItem[] = [];
  const itemsByIndex = new Map<number, RenderableMessageItem>();
  const collapsedIndices = new Set<number>();
  const turns = createMessageTurns(messages);
  const liveTurn = options.isAssistantWorking ? turns[turns.length - 1] : null;

  messages.forEach((message, originalIndex) => {
    if (message.isAgentActivitySummary) {
      return;
    }
    if (
      liveTurn &&
      originalIndex >= liveTurn.start &&
      originalIndex < liveTurn.end &&
      isLiveProcessMessage(message)
    ) {
      collapsedIndices.add(originalIndex);
      return;
    }

    const item: RenderableMessageItem = { message, originalIndex, processSummary: null, processDetailMessages: [] };
    items.push(item);
    itemsByIndex.set(originalIndex, item);
  });

  attachSummariesToTurns(messages, turns);

  turns.forEach((turn, turnIndex) => {
    let host: RenderableMessageItem | null = null;
    for (let index = turn.end - 1; index >= turn.start; index -= 1) {
      const message = messages[index];
      if (!message || !canHostProcessSummary(message)) {
        continue;
      }
      host = itemsByIndex.get(index) || null;
      if (host) break;
    }

    if (!host) {
      if (turn.summary) {
        items.push({ message: turn.summary.message, originalIndex: turn.summary.originalIndex, processSummary: null });
      }
      return;
    }

    const isLatestTurn = turnIndex === turns.length - 1;
    const shouldKeepTurnExpanded = Boolean(options.isAssistantWorking && isLatestTurn);
    if (shouldKeepTurnExpanded) {
      return;
    }

    const detailMessages: ChatMessage[] = [];
    for (let index = turn.start; index < turn.end; index += 1) {
      if (index === host.originalIndex) {
        continue;
      }
      const message = messages[index];
      if (!message || !isCollapsibleProcessMessage(message)) {
        continue;
      }
      detailMessages.push(message);
      collapsedIndices.add(index);
    }

    if (detailMessages.length === 0 && !turn.summary) {
      return;
    }

    host.processSummary =
      turn.summary?.message || createSyntheticProcessSummary(messages, turn, host.originalIndex, detailMessages);
    host.processDetailMessages = detailMessages;
  });

  return items
    .filter((item) => !collapsedIndices.has(item.originalIndex))
    .sort((a, b) => a.originalIndex - b.originalIndex);
}

export function getLiveProcessDetailMessages(messages: ChatMessage[]): ChatMessage[] {
  return getLiveProcessGroups(messages, { isAssistantWorking: true })
    .flatMap((group) => group.detailMessages);
}

export function getLiveProcessGroups(
  messages: ChatMessage[],
  options: BuildRenderableMessageItemsOptions = {},
): LiveProcessGroup[] {
  const turns = createMessageTurns(messages);
  const liveTurn = turns[turns.length - 1];
  if (!liveTurn) {
    return [];
  }

  const groups: Omit<LiveProcessGroup, 'isRunning'>[] = [];
  let previousVisibleIndex = liveTurn.start;
  let groupStartIndex = -1;
  let groupMessages: ChatMessage[] = [];

  const finishGroup = (beforeOriginalIndex: number | null) => {
    if (groupMessages.length === 0 || previousVisibleIndex < 0) {
      groupStartIndex = -1;
      groupMessages = [];
      return;
    }

    const first = groupMessages[0];
    const last = groupMessages[groupMessages.length - 1];
    groups.push({
      id: [
        'live-process',
        first.id || first.toolId || groupStartIndex,
        last.id || last.toolId || beforeOriginalIndex || messages.length,
      ].join('-'),
      afterOriginalIndex: previousVisibleIndex,
      beforeOriginalIndex,
      startIndex: groupStartIndex,
      endIndex: beforeOriginalIndex ?? messages.length,
      messages: groupMessages,
      detailMessages: groupMessages.filter(isExpandableLiveProcessMessage),
    });
    groupStartIndex = -1;
    groupMessages = [];
  };

  for (let index = liveTurn.start; index < liveTurn.end; index += 1) {
    const message = messages[index];
    if (!message || message.isAgentActivity || message.isAgentActivitySummary) {
      continue;
    }

    if (isLiveProcessMessage(message)) {
      if (groupMessages.length === 0) {
        groupStartIndex = index;
      }
      groupMessages.push(message);
      continue;
    }

    finishGroup(index);
    previousVisibleIndex = index;
  }

  finishGroup(null);

  return groups.map((group, index) => {
    const isLatestGroup = index === groups.length - 1;
    const isOpenEnded = group.beforeOriginalIndex == null;
    return {
      ...group,
      isRunning: Boolean(options.isAssistantWorking && isLatestGroup && isOpenEnded),
    };
  });
}

function MeasuredMessageItem({
  itemKey,
  message,
  isLast,
  compactBottomSpacing = false,
  onHeightChange,
  children,
}: {
  itemKey: string;
  message: ChatMessage;
  isLast: boolean;
  compactBottomSpacing?: boolean;
  onHeightChange: (itemKey: string, height: number) => void;
  children: ReactNode;
}) {
  const itemRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = itemRef.current;
    if (!node) return undefined;

    const reportHeight = () => {
      onHeightChange(itemKey, node.getBoundingClientRect().height);
    };

    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(node);

    return () => observer.disconnect();
  }, [itemKey, onHeightChange]);

  return (
    <div
      ref={itemRef}
      className={`chat-message ${isLast ? '' : compactBottomSpacing ? 'pb-3' : 'pb-8'}`}
      data-message-timestamp={message.timestamp ? String(message.timestamp) : undefined}
    >
      {children}
    </div>
  );
}

export default function MessagesPaneV2({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  sessionLoadError,
  onRetrySessionLoad,
  chatMessages,
  activityMessages = [],
  visibleMessages,
  provider,
  selectedProject,
  selectedSession,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  autoExpandTools,
  showRawParameters,
  showThinking,
  setInput,
  isAssistantWorking = false,
  workingStatus,
  runMode = 'agent',
}: MessagesPaneV2Props) {
  const { t } = useTranslation('chat');
  const messageKeyMapRef = useRef<WeakMap<ChatMessage, string>>(new WeakMap());
  const generatedMessageKeyCounterRef = useRef(0);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const heightVersionRafRef = useRef<number | null>(null);
  const [heightVersion, setHeightVersion] = useState(0);
  const [scrollViewport, setScrollViewport] = useState({ scrollTop: 0, height: 0 });

  const getMessageKey = useCallback((message: ChatMessage, index: number) => {
    const existingKey = messageKeyMapRef.current.get(message);
    if (existingKey) return existingKey;

    const intrinsicKey = getIntrinsicMessageKey(message);
    if (intrinsicKey) {
      messageKeyMapRef.current.set(message, intrinsicKey);
      return intrinsicKey;
    }

    generatedMessageKeyCounterRef.current += 1;
    const candidateKey = `message-generated-${index}-${generatedMessageKeyCounterRef.current}`;
    messageKeyMapRef.current.set(message, candidateKey);
    return candidateKey;
  }, []);

  const suggestedPrompts: string[] = [
    t('emptyChat.prompts.plan', { defaultValue: 'Plan a refactor for this project' }),
    t('emptyChat.prompts.summary', { defaultValue: 'Summarize recent changes' }),
    t('emptyChat.prompts.review', { defaultValue: 'Review the most recent file I touched' }),
  ];

  const isEmpty = !isLoadingSessionMessages && chatMessages.length === 0;
  const hasSessionLoadError = Boolean(!isLoadingSessionMessages && sessionLoadError && chatMessages.length === 0);
  const isNewConversationEmpty = isEmpty && !selectedSession;
  const isExistingConversationEmpty = isEmpty && Boolean(selectedSession) && !hasSessionLoadError;
  const isReadOnlyBackgroundSession = isBackgroundTaskSession(selectedSession);
  const liveActivities = useMemo(
    () => activityMessages.filter((message) => message.isAgentActivity),
    [activityMessages],
  );
  const renderableMessages = useMemo(
    () => visibleMessages.filter((message) => !message.isAgentActivity),
    [visibleMessages],
  );
  const liveProcessDetailMessages = useMemo(
    () => isAssistantWorking ? getLiveProcessDetailMessages(renderableMessages) : [],
    [isAssistantWorking, renderableMessages],
  );
  const liveProcessGroups = useMemo(
    () => isAssistantWorking
      ? getLiveProcessGroups(renderableMessages, { isAssistantWorking })
        .filter((group) => shouldRenderLiveProcessGroup(group, runMode))
      : [],
    [isAssistantWorking, renderableMessages, runMode],
  );
  const liveProcessGroupsByAnchor = useMemo(() => {
    const groupsByAnchor = new Map<number, LiveProcessGroup[]>();
    for (const group of liveProcessGroups) {
      const groups = groupsByAnchor.get(group.afterOriginalIndex) || [];
      groups.push(group);
      groupsByAnchor.set(group.afterOriginalIndex, groups);
    }
    return groupsByAnchor;
  }, [liveProcessGroups]);
  const renderableMessageItems = useMemo(
    () => buildRenderableMessageItems(renderableMessages, { isAssistantWorking }),
    [isAssistantWorking, renderableMessages],
  );
  const keyedMessageItems = useMemo<KeyedRenderableMessageItem[]>(
    () => renderableMessageItems.map((item, index) => ({
      ...item,
      itemKey: getMessageKey(item.message, index),
      renderIndex: index,
      estimatedHeight: estimateMessageItemHeight(item),
    })),
    [getMessageKey, renderableMessageItems],
  );
  const measuredItemHeights = useMemo(
    () => keyedMessageItems.map((item) => measuredHeightsRef.current.get(item.itemKey) ?? item.estimatedHeight),
    [heightVersion, keyedMessageItems],
  );
  const shouldVirtualizeMessages = keyedMessageItems.length > MESSAGE_VIRTUALIZATION_THRESHOLD;
  const virtualWindow = useMemo(
    () => shouldVirtualizeMessages
      ? getVirtualMessageWindow(
          measuredItemHeights,
          scrollViewport.scrollTop,
          scrollViewport.height,
          MESSAGE_WINDOW_OVERSCAN,
        )
      : {
          startIndex: 0,
          endIndex: keyedMessageItems.length,
          topPadding: 0,
          bottomPadding: 0,
          totalHeight: measuredItemHeights.reduce((sum, height) => sum + height, 0),
        },
    [keyedMessageItems.length, measuredItemHeights, scrollViewport.height, scrollViewport.scrollTop, shouldVirtualizeMessages],
  );
  const windowedMessageItems = shouldVirtualizeMessages
    ? keyedMessageItems.slice(virtualWindow.startIndex, virtualWindow.endIndex)
    : keyedMessageItems;
  const liveProcessHeaderIndex = useMemo(() => {
    if (!isAssistantWorking) return -1;
    for (let index = keyedMessageItems.length - 1; index >= 0; index -= 1) {
      if (keyedMessageItems[index].message.type === 'user') {
        return Math.min(index + 1, keyedMessageItems.length);
      }
    }
    return keyedMessageItems.length > 0 ? 0 : -1;
  }, [isAssistantWorking, keyedMessageItems]);
  const hasLiveAssistantContent = useMemo(() => {
    if (!isAssistantWorking || liveProcessHeaderIndex < 0) return false;
    return keyedMessageItems.slice(liveProcessHeaderIndex).some((item) => (
      item.message.type === 'assistant' &&
      !item.message.isThinking &&
      !item.message.isToolUse &&
      typeof item.message.content === 'string' &&
      item.message.content.trim().length > 0
    ));
  }, [isAssistantWorking, keyedMessageItems, liveProcessHeaderIndex]);
  const liveStatusStep = useMemo(
    () => getLiveStatusStep(liveActivities, workingStatus, hasLiveAssistantContent, t),
    [hasLiveAssistantContent, liveActivities, t, workingStatus],
  );
  const shouldRenderBottomLiveStatus = isAssistantWorking && liveProcessGroups.length === 0;

  const bumpHeightVersion = useCallback(() => {
    if (heightVersionRafRef.current !== null) return;
    heightVersionRafRef.current = requestAnimationFrame(() => {
      heightVersionRafRef.current = null;
      setHeightVersion((version) => version + 1);
    });
  }, []);

  const handleMeasuredItemHeight = useCallback((itemKey: string, height: number) => {
    const normalizedHeight = Math.max(1, Math.ceil(height));
    const currentHeight = measuredHeightsRef.current.get(itemKey);
    if (currentHeight !== undefined && Math.abs(currentHeight - normalizedHeight) < 2) {
      return;
    }

    measuredHeightsRef.current.set(itemKey, normalizedHeight);
    bumpHeightVersion();
  }, [bumpHeightVersion]);

  useEffect(() => () => {
    if (heightVersionRafRef.current !== null) {
      cancelAnimationFrame(heightVersionRafRef.current);
    }
  }, []);

  useEffect(() => {
    const validKeys = new Set(keyedMessageItems.map((item) => item.itemKey));
    let changed = false;

    for (const itemKey of measuredHeightsRef.current.keys()) {
      if (!validKeys.has(itemKey)) {
        measuredHeightsRef.current.delete(itemKey);
        changed = true;
      }
    }

    if (changed) {
      bumpHeightVersion();
    }
  }, [bumpHeightVersion, keyedMessageItems]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    let frame = 0;
    const updateViewport = () => {
      frame = 0;
      setScrollViewport({
        scrollTop: container.scrollTop,
        height: container.clientHeight,
      });
    };
    const scheduleViewportUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(updateViewport);
    };

    updateViewport();
    container.addEventListener('scroll', scheduleViewportUpdate, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleViewportUpdate);
    resizeObserver.observe(container);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener('scroll', scheduleViewportUpdate);
      resizeObserver.disconnect();
    };
  }, [scrollContainerRef]);

  const renderLiveProcessDetailMessages = useCallback((detailMessages: ChatMessage[], groupId: string) => (
    detailMessages.map((message: ChatMessage, index: number) => (
      <MessageRowV2
        key={`${groupId}-${getMessageKey(message, index)}`}
        message={message}
        prevMessage={index > 0 ? detailMessages[index - 1] : null}
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
    ))
  ), [
    autoExpandTools,
    createDiff,
    getMessageKey,
    onFileOpen,
    onGrantToolPermission,
    onShowSettings,
    provider,
    selectedProject,
    showRawParameters,
    showThinking,
  ]);

  const renderLiveProcessGroup = useCallback((group: LiveProcessGroup, index: number) => {
    const isLatestGroup = liveProcessGroups[liveProcessGroups.length - 1]?.id === group.id;
    const step = getLiveProcessGroupStep(group, t, group.isRunning && isLatestGroup ? liveStatusStep : null);

    return (
      <ProcessLiveStatus
        key={group.id || `${group.afterOriginalIndex}-${index}`}
        step={step}
        compact
      >
        {group.detailMessages.length > 0
          ? renderLiveProcessDetailMessages(group.detailMessages, group.id)
          : null}
      </ProcessLiveStatus>
    );
  }, [liveProcessGroups, liveStatusStep, renderLiveProcessDetailMessages, t]);

  const renderMessageItem = useCallback((item: KeyedRenderableMessageItem) => {
    const previousMessage = item.renderIndex > 0 ? keyedMessageItems[item.renderIndex - 1].message : null;
    const isLast = !isAssistantWorking && item.renderIndex === keyedMessageItems.length - 1;
    const anchoredLiveGroups = liveProcessGroupsByAnchor.get(item.originalIndex) || [];
    const rendersLiveHeaderAfterItem = item.renderIndex === liveProcessHeaderIndex - 1;

    return (
      <Fragment key={item.itemKey}>
        {liveProcessHeaderIndex === 0 && item.renderIndex === 0 ? (
          <LiveProcessHeader activities={liveActivities} t={t} />
        ) : null}
        <MeasuredMessageItem
          itemKey={item.itemKey}
          message={item.message}
          isLast={isLast}
          compactBottomSpacing={anchoredLiveGroups.length > 0 || rendersLiveHeaderAfterItem}
          onHeightChange={handleMeasuredItemHeight}
        >
          <MessageRowV2
            message={item.message}
            prevMessage={previousMessage}
            processSummary={item.processSummary}
            processDetailMessages={item.processDetailMessages}
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
          {rendersLiveHeaderAfterItem ? (
            <LiveProcessHeader activities={liveActivities} t={t} />
          ) : null}
          {anchoredLiveGroups.map(renderLiveProcessGroup)}
        </MeasuredMessageItem>
      </Fragment>
    );
  }, [
    autoExpandTools,
    createDiff,
    handleMeasuredItemHeight,
    isAssistantWorking,
    keyedMessageItems,
    liveActivities,
    liveProcessHeaderIndex,
    liveProcessGroupsByAnchor,
    onFileOpen,
    onGrantToolPermission,
    onShowSettings,
    provider,
    renderLiveProcessGroup,
    selectedProject,
    showRawParameters,
    showThinking,
    t,
  ]);

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="relative flex-1 overflow-y-auto overflow-x-hidden bg-white dark:bg-neutral-950"
    >
      {hasSessionLoadError ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <XCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" strokeWidth={1.75} />
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {t('session.loadFailedTitle', { defaultValue: 'Could not load this conversation' })}
          </div>
          <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
            {sessionLoadError}
          </div>
          {onRetrySessionLoad ? (
            <button
              type="button"
              onClick={onRetrySessionLoad}
              className="inline-flex h-8 items-center rounded-md border border-neutral-200 px-3 text-[13px] font-medium text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              {t('session.retryLoad', { defaultValue: 'Retry' })}
            </button>
          ) : null}
        </div>
      ) : isLoadingSessionMessages && chatMessages.length === 0 ? (
        <div className="mx-auto flex h-full max-w-[720px] items-center justify-center px-6 py-10 text-[13px] text-neutral-500 dark:text-neutral-400">
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-neutral-400" />
            <span>{t('loading', { defaultValue: 'Loading…' })}</span>
          </div>
        </div>
      ) : isNewConversationEmpty ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {selectedProject
              ? t('emptyChat.title', { defaultValue: 'Start a new conversation' })
              : t('emptyChat.noProject', { defaultValue: 'Pick a project from the sidebar' })}
          </div>
          {selectedProject ? (
            <div className="flex flex-col gap-1.5">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                  className="rounded-lg border border-neutral-200 px-3 py-1.5 text-left text-[13px] text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : isExistingConversationEmpty ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {isReadOnlyBackgroundSession
              ? t('emptyChat.readonlyBackgroundTitle', {
                  defaultValue: 'No displayable messages in this task transcript',
                })
              : t('emptyChat.emptySessionTitle', {
                  defaultValue: 'No displayable messages in this conversation',
                })}
          </div>
          <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
            {isReadOnlyBackgroundSession
              ? t('emptyChat.readonlyBackgroundDescription', {
                  defaultValue:
                    'This read-only background task transcript only contains records the chat view cannot display.',
                })
              : t('emptyChat.emptySessionDescription', {
                  defaultValue:
                    'This conversation exists, but it does not contain messages that can be rendered here.',
                })}
          </div>
        </div>
      ) : (
        <div
          className="mx-auto max-w-[860px] px-6 py-10"
          data-virtualized-messages={shouldVirtualizeMessages ? 'true' : undefined}
          data-rendered-message-count={windowedMessageItems.length}
          data-total-message-count={keyedMessageItems.length}
        >
          {shouldVirtualizeMessages && virtualWindow.topPadding > 0 ? (
            <div aria-hidden="true" style={{ height: virtualWindow.topPadding }} />
          ) : null}

          {windowedMessageItems.map(renderMessageItem)}

          {shouldVirtualizeMessages && virtualWindow.bottomPadding > 0 ? (
            <div aria-hidden="true" style={{ height: virtualWindow.bottomPadding }} />
          ) : null}

          {isAssistantWorking &&
          liveProcessHeaderIndex === keyedMessageItems.length &&
          keyedMessageItems[liveProcessHeaderIndex - 1]?.message.type !== 'user' ? (
            <LiveProcessHeader activities={liveActivities} t={t} />
          ) : null}

          {shouldRenderBottomLiveStatus ? (
            <ProcessLiveStatus step={liveStatusStep}>
              {liveProcessDetailMessages.length > 0
                ? renderLiveProcessDetailMessages(liveProcessDetailMessages, 'bottom-live-process')
                : null}
            </ProcessLiveStatus>
          ) : null}
        </div>
      )}
    </div>
  );
}

function getLatestActivity(activities: ChatMessage[]): ChatMessage | null {
  const byId = new Map<string, ChatMessage>();
  for (const activity of activities) {
    const key = str(activity.activityId) || str(activity.id) || `${str(activity.runId)}-${activity.timestamp}`;
    byId.set(key, activity);
  }
  const latest = Array.from(byId.values());
  return [...latest].reverse().find((activity) => str(activity.state) === 'running') || latest[latest.length - 1] || null;
}

function activityToLiveStep(activity: ChatMessage): ProcessTraceStep {
  return {
    id: str(activity.activityId) || str(activity.id),
    title: str(activity.title) || str(activity.content) || str(activity.toolName),
    detail: str(activity.detail),
    state: str(activity.state) || 'running',
    severity: str(activity.severity) || undefined,
    phase: str(activity.phase) || undefined,
    toolName: str(activity.toolName) || undefined,
  };
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getToolInputString(message: ChatMessage, key: string): string {
  const input = parseToolInput(message.toolInput);
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function getToolTarget(message: ChatMessage): string {
  return (
    getToolInputString(message, 'file_path') ||
    getToolInputString(message, 'path') ||
    getToolInputString(message, 'pattern') ||
    getToolInputString(message, 'query') ||
    getToolInputString(message, 'command') ||
    ''
  );
}

function getDisplayTarget(target: string): string {
  if (!target) return '';
  const normalized = target.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || target;
}

function getLiveProcessToolKind(message: ChatMessage): 'edit' | 'read' | 'search' | 'command' | 'subagent' | 'compact' | 'thinking' | 'tool' {
  if (message.isCompactBoundary) return 'compact';
  if (message.isThinking) return 'thinking';
  if (message.isSubagentContainer || message.toolName === 'Task' || message.isTaskNotification) return 'subagent';

  const toolName = String(message.toolName || '').toLowerCase();
  if (/edit|write|applypatch|patch|update|create/.test(toolName)) return 'edit';
  if (/read/.test(toolName)) return 'read';
  if (/grep|glob|search|websearch|rag|find/.test(toolName) || message.phase === 'rag') return 'search';
  if (/bash|shell|terminal|exec|command|run/.test(toolName)) return 'command';
  return 'tool';
}

function shouldRenderLiveProcessGroup(group: LiveProcessGroup, runMode: ChatRunMode): boolean {
  if (runMode !== 'plan') {
    return true;
  }
  return !group.messages.every((message) => message.isCompactBoundary);
}

function uniqueCount(values: string[]): number {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? new Set(normalized).size : values.length;
}

function formatLiveProcessCompletedTitle(
  group: LiveProcessGroup,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const editTargets: string[] = [];
  const readTargets: string[] = [];
  let searchCount = 0;
  let commandCount = 0;
  let otherToolCount = 0;
  let hasSubagent = false;
  let hasCompact = false;
  let hasThinking = false;

  for (const message of group.messages) {
    const kind = getLiveProcessToolKind(message);
    if (kind === 'edit') {
      editTargets.push(getToolTarget(message));
    } else if (kind === 'read') {
      readTargets.push(getToolTarget(message));
    } else if (kind === 'search') {
      searchCount += 1;
    } else if (kind === 'command') {
      commandCount += 1;
    } else if (kind === 'subagent') {
      hasSubagent = true;
    } else if (kind === 'compact') {
      hasCompact = true;
    } else if (kind === 'thinking') {
      hasThinking = true;
    } else {
      otherToolCount += 1;
    }
  }

  const labels: string[] = [];
  const editCount = uniqueCount(editTargets);
  const readCount = uniqueCount(readTargets);

  if (editCount > 0) {
    labels.push(t('process.live.editedFiles', {
      count: editCount,
      defaultValue: `Edited ${editCount} ${editCount === 1 ? 'file' : 'files'}`,
    }));
  }
  if (readCount > 0) {
    labels.push(t('process.live.exploredFiles', {
      count: readCount,
      defaultValue: `Explored ${readCount} ${readCount === 1 ? 'file' : 'files'}`,
    }));
  }
  if (searchCount > 0) {
    labels.push(t('process.live.searches', {
      count: searchCount,
      defaultValue: `Searched ${searchCount} ${searchCount === 1 ? 'time' : 'times'}`,
    }));
  }
  if (commandCount > 0) {
    labels.push(t('process.live.commands', {
      count: commandCount,
      defaultValue: `Ran ${commandCount} ${commandCount === 1 ? 'command' : 'commands'}`,
    }));
  }
  if (hasSubagent) {
    labels.push(t('process.live.subagentCompleted', { defaultValue: 'Subagent finished' }));
  }
  if (hasCompact) {
    labels.push(t('process.live.compactCompleted', { defaultValue: 'Compacted context' }));
  }
  if (hasThinking) {
    labels.push(t('process.live.thoughtCompleted', { defaultValue: 'Thought through next step' }));
  }
  if (labels.length === 0 && otherToolCount > 0) {
    labels.push(t('process.live.toolCalls', {
      count: otherToolCount,
      defaultValue: `Used ${otherToolCount} ${otherToolCount === 1 ? 'tool' : 'tools'}`,
    }));
  }

  return labels.join(', ');
}

function getRunningLiveProcessTitle(
  group: LiveProcessGroup,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const latestMessage = [...group.messages].reverse().find((message) => isLiveProcessMessage(message));
  if (!latestMessage) {
    return t('working.processing', { defaultValue: 'Processing' });
  }

  const kind = getLiveProcessToolKind(latestMessage);
  const target = getDisplayTarget(getToolTarget(latestMessage));
  if (kind === 'edit') {
    return target
      ? t('process.live.runningEditTarget', { target, defaultValue: `Editing ${target}` })
      : t('process.live.runningEdit', { defaultValue: 'Editing file' });
  }
  if (kind === 'read') {
    return target
      ? t('process.live.runningReadTarget', { target, defaultValue: `Reading ${target}` })
      : t('process.live.runningRead', { defaultValue: 'Reading file' });
  }
  if (kind === 'search') {
    return target
      ? t('process.live.runningSearchTarget', { target, defaultValue: `Searching ${target}` })
      : t('process.live.runningSearch', { defaultValue: 'Searching' });
  }
  if (kind === 'command') {
    return target
      ? t('process.live.runningCommandTarget', { target, defaultValue: `Running ${target}` })
      : t('process.live.runningCommand', { defaultValue: 'Running command' });
  }
  if (kind === 'subagent') {
    return t('process.live.runningSubagent', { defaultValue: 'Running subagent' });
  }
  if (kind === 'compact') {
    return t('working.compacting', { defaultValue: 'Compacting context...' });
  }
  if (kind === 'thinking') {
    return t('working.thinking', { defaultValue: 'Thinking' });
  }
  return str(latestMessage.title) || str(latestMessage.content) || str(latestMessage.toolName) || t('working.processing', { defaultValue: 'Processing' });
}

function getLiveProcessGroupStep(
  group: LiveProcessGroup,
  t: (key: string, options?: Record<string, unknown>) => string,
  fallbackRunningStep: ProcessTraceStep | null,
): ProcessTraceStep {
  const fallbackPhase = String(fallbackRunningStep?.phase || '');
  const canUseFallbackStep = fallbackRunningStep?.title &&
    !['generation', 'thinking', 'permission'].includes(fallbackPhase);
  if (group.isRunning && canUseFallbackStep) {
    return {
      ...fallbackRunningStep,
      id: group.id,
      state: fallbackRunningStep.state || 'running',
    };
  }

  const title = group.isRunning
    ? getRunningLiveProcessTitle(group, t)
    : formatLiveProcessCompletedTitle(group, t);
  const latestMessage = group.messages[group.messages.length - 1];
  const kind = latestMessage ? getLiveProcessToolKind(latestMessage) : 'tool';

  return {
    id: group.id,
    title,
    state: group.isRunning ? 'running' : 'completed',
    phase: kind === 'search' ? 'rag' : kind === 'command' ? 'tool' : str(latestMessage?.phase) || undefined,
    toolName: str(latestMessage?.toolName) || undefined,
  };
}

function getLiveStatusStep(
  activities: ChatMessage[],
  workingStatus: ClaudeWorkStatus | null | undefined,
  hasAssistantContent: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): ProcessTraceStep {
  const latestActivity = getLatestActivity(activities);
  if (latestActivity) {
    return activityToLiveStep(latestActivity);
  }

  if (workingStatus?.compactProgress) {
    const progress = workingStatus.compactProgress;
    return {
      id: 'live-compact',
      title: t('working.compacting', { defaultValue: 'Compacting context...' }),
      detail: progress.label || progress.stage || '',
      phase: 'compact',
      state: progress.state || 'running',
    };
  }

  const rawStatus = String(workingStatus?.text || '').toLowerCase();
  if (rawStatus.includes('permission')) {
    return {
      id: 'live-permission',
      title: t('working.waitingForPermission', { defaultValue: 'Waiting for permission' }),
      phase: 'permission',
      state: 'running',
      severity: 'warning',
    };
  }
  if (rawStatus.includes('compact')) {
    return {
      id: 'live-compact',
      title: t('working.compacting', { defaultValue: 'Compacting context...' }),
      phase: 'compact',
      state: 'running',
    };
  }

  return hasAssistantContent
    ? {
        id: 'live-generation',
        title: t('working.generating', { defaultValue: '正在生成回复' }),
        phase: 'generation',
        state: 'running',
      }
    : {
        id: 'live-thinking',
        title: t('working.thinking', { defaultValue: 'Thinking' }),
        phase: 'thinking',
        state: 'running',
      };
}

function getLiveProcessStartedAtMs(activities: ChatMessage[], fallbackStartedAtMs: number): number {
  const byId = new Map<string, ChatMessage>();
  for (const activity of activities) {
    const key = str(activity.activityId) || str(activity.id) || `${str(activity.runId)}-${activity.timestamp}`;
    byId.set(key, activity);
  }
  const latest = Array.from(byId.values());
  const startedAt = str(latest[0]?.startedAt) || String(latest[0]?.timestamp || '');
  const startedAtMs = startedAt ? Date.parse(startedAt) : fallbackStartedAtMs;
  return Number.isFinite(startedAtMs) ? startedAtMs : fallbackStartedAtMs;
}

function LiveProcessHeader({
  activities,
  t,
}: {
  activities: ChatMessage[];
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const fallbackStartedAtRef = useRef(Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedMs = useMemo(
    () => nowMs - getLiveProcessStartedAtMs(activities, fallbackStartedAtRef.current),
    [activities, nowMs],
  );
  const duration = formatProcessDuration(elapsedMs);
  const label = t('process.summary.processed', {
    duration,
    defaultValue: `Processed ${duration}`,
  });

  return <ProcessRunHeader label={label} />;
}

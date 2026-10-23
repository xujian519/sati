import type { Dispatch, RefObject, SetStateAction } from "react";
import type { DiffLine } from "../chat/utils/messageTransforms";
import type {
  ChatMessage,
  ChatRunMode,
  ClaudeWorkStatus,
  SatiWorkStatus,
  SatiPermissionSuggestion,
  SessionPermissionGrantResult,
} from "../chat/types/types";
import type { SessionStore } from "../../stores/useSessionStore";
import type { Project, ProjectSession, SessionProvider } from "../../types/app";
import type { RenderableMessageItem } from "./processGrouping";

export type MessagesPaneV2Props = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  sessionLoadError?: string | null;
  onRetrySessionLoad?: () => void;
  chatMessages: ChatMessage[];
  activityMessages?: ChatMessage[];
  visibleMessages: ChatMessage[];
  visibleMessageCount: number;
  hasMoreMessages: boolean;
  totalMessages: number;
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantSessionToolPermission?: (
    suggestion: SatiPermissionSuggestion,
  ) => SessionPermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  inlineThinking?: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  isAssistantWorking?: boolean;
  workingStatus?: ClaudeWorkStatus | SatiWorkStatus | null;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
  sessionStore?: SessionStore;
  onFork?: (message: ChatMessage, carriedMessageCount: number) => void;
  forkDisabled?: boolean;
  forkParentSessionTitle?: string | null;
  // 协议 1.7：最后一条 user/assistant 消息的编辑/重新生成动作。
  onEditLastUserMessage?: (message: ChatMessage) => void;
  onRegenerateLastTurn?: (message: ChatMessage) => void;
};

export type KeyedRenderableMessageItem = RenderableMessageItem & {
  itemKey: string;
  renderIndex: number;
  estimatedHeight: number;
};

export type RenderableItemsCache = {
  messages: ChatMessage[];
  isAssistantWorking: boolean;
  result: RenderableMessageItem[];
};

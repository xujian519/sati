import type { GatewayEvent, GatewayMode, GatewaySessionInfo } from "../../../../gateway/index.js";

export type TuiConnectionMode = "remote" | "in_process";

export type TuiMessage =
  | { role: "system"; text: string }
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; thinking?: string }
  | { role: "tool"; text: string; ok?: boolean }
  | { role: "error"; text: string };

export type TuiActivityItem = {
  id: string;
  text: string;
  status: "running" | "done" | "error" | "info";
};

export type TuiAppState = {
  connection: TuiConnectionMode;
  activeSessionKey: string;
  sessions: GatewaySessionInfo[];
  messages: TuiMessage[];
  activity: TuiActivityItem[];
  input: string;
  mode: GatewayMode;
  isRunning: boolean;
  helpOpen: boolean;
  scrollOffset: number;
};

export type TuiEventReducerResult = Pick<TuiAppState, "messages" | "activity" | "mode" | "isRunning">;

export function applyGatewayEventToTuiState(state: TuiEventReducerResult, event: GatewayEvent): TuiEventReducerResult {
  switch (event.type) {
    case "turn_started":
      return {
        ...state,
        isRunning: true,
        activity: [],
      };
    case "assistant_text_delta":
      return appendAssistantText(state, event.text);
    case "assistant_thinking_delta":
      return {
        ...appendAssistantThinking(state, event.text),
        activity: [{ id: `thinking-${state.activity.length}`, text: event.text, status: "info" as const }, ...state.activity].slice(0, 8),
      };
    case "tool_call_started":
      return {
        ...state,
        activity: [{ id: event.toolCallId, text: event.name, status: "running" as const }, ...state.activity].slice(0, 8),
      };
    case "tool_call_finished": {
      const preview = (event.resultPreview ?? "").trim();
      const text = preview.length > 0 ? preview : event.ok ? "ok" : "error";
      return {
        ...state,
        messages: [...state.messages, { role: "tool", text, ok: event.ok }],
        activity: state.activity.filter((item) => item.id !== event.toolCallId),
      };
    }
    case "permission_request":
      return {
        ...state,
        activity: [{ id: event.requestId, text: `permission: ${event.toolName}`, status: "info" as const }, ...state.activity].slice(0, 8),
      };
    case "structured_output":
      return {
        ...state,
        messages: [...state.messages, { role: "system", text: JSON.stringify(event.payload, null, 2) }],
      };
    case "plan_mode_changed":
      return { ...state, mode: event.mode as GatewayMode };
    case "turn_completed":
      return { ...state, isRunning: false, activity: [] };
    case "error":
      return {
        ...state,
        isRunning: false,
        activity: [],
        messages: [...state.messages, { role: "error", text: event.message }],
      };
  }
  return state;
}

function appendAssistantText(state: TuiEventReducerResult, text: string): TuiEventReducerResult {
  if (!text) {
    return state;
  }
  const last = state.messages.at(-1);
  if (last?.role === "assistant") {
    return {
      ...state,
      messages: [...state.messages.slice(0, -1), { role: "assistant", text: `${last.text}${text}`, thinking: last.thinking }],
    };
  }
  return {
    ...state,
    messages: [...state.messages, { role: "assistant", text }],
  };
}

function appendAssistantThinking(state: TuiEventReducerResult, text: string): TuiEventReducerResult {
  if (!text) {
    return state;
  }
  const last = state.messages.at(-1);
  if (last?.role === "assistant") {
    return {
      ...state,
      messages: [...state.messages.slice(0, -1), { role: "assistant", text: last.text, thinking: `${last.thinking ?? ""}${text}` }],
    };
  }
  return {
    ...state,
    messages: [...state.messages, { role: "assistant", text: "", thinking: text }],
  };
}

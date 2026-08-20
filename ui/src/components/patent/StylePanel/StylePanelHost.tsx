/**
 * StylePanel 全局宿主：Provider + 订阅 tool_call_finished 的 payload
 * （document_style_panel → { kind, htmlPath, style }）自动打开右侧抽屉。
 * 挂载于 AppShellV2（全局一次）。
 */

import { useEffect, useRef } from "react";
import type { SessionProvider } from "../../../types/app";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import StylePanelDrawer from "./StylePanelDrawer";
import { StylePanelProvider, useStylePanel } from "./StylePanelContext";
import type { StylePanelData } from "./types";

type StylePanelHostProps = {
  sendMessage: (message: Record<string, unknown>) => void;
  subscribe: (handler: (msg: WsMessage) => void) => () => void;
  projectName: string;
  projectPath: string;
  sessionId: string | null;
  provider: SessionProvider;
};

function isStylePanelData(value: unknown): value is StylePanelData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "document_style_panel" && typeof record.htmlPath === "string";
}

function StylePanelHostInner(props: StylePanelHostProps) {
  const { openPanel } = useStylePanel();
  const openPanelRef = useRef(openPanel);
  openPanelRef.current = openPanel;
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    return propsRef.current.subscribe((message: WsMessage) => {
      if (message.kind !== "tool_result") return;
      if (message.payload === undefined) return;
      if (isStylePanelData(message.payload)) {
        openPanelRef.current(message.payload.htmlPath, message.payload.style);
      }
    });
  }, []);

  return (
    <StylePanelDrawer
      sendMessage={props.sendMessage}
      projectName={props.projectName}
      projectPath={props.projectPath}
      sessionId={props.sessionId}
      provider={props.provider}
    />
  );
}

export default function StylePanelHost(props: StylePanelHostProps) {
  return (
    <StylePanelProvider>
      <StylePanelHostInner {...props} />
    </StylePanelProvider>
  );
}

import { useEffect, useRef } from "react";
import type { WsMessage } from "../../../contexts/WebSocketContext";

type UsePendingPermissionsSyncArgs = {
  isConnected: boolean;
  selectedSessionId?: string;
  sendMessage: (message: WsMessage) => void;
};

/** 连接就绪/重连后补拉当前会话的待处理权限请求。 */
export function usePendingPermissionsSync({
  isConnected,
  selectedSessionId,
  sendMessage,
}: UsePendingPermissionsSyncArgs) {
  const wasConnectedRef = useRef(false);

  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;
    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSessionId) {
      sendMessage({
        type: "get-pending-permissions",
        sessionId: selectedSessionId,
      });
    }
  }, [isConnected, selectedSessionId, sendMessage]);
}

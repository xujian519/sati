import { useCallback, useRef } from "react";

/**
 * 流式缓冲三件套（buffer / timer / accumulated）与统一重置入口。
 * #646 B2.6：从 ChatInterfaceV2 原样外置，ref 句柄由调用方持有并继续传入
 * useChatSessionState / reconnect；`resetStreamingState` 语义与搬迁前一致。
 */
export function useChatStreamBuffers() {
  const streamBufferRef = useRef("");
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef("");

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamBufferRef.current = "";
    accumulatedStreamRef.current = "";
  }, []);

  return { streamBufferRef, streamTimerRef, accumulatedStreamRef, resetStreamingState };
}

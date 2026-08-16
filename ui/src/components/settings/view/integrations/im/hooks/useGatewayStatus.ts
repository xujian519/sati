import { useCallback, useEffect, useState } from "react";
import { authenticatedFetch } from "../../../../../../utils/api";
import type { GatewayStatus } from "../types";

type FetchGatewayStatusOptions = { showLoading?: boolean };
export type RefreshGatewayStatus = (options?: FetchGatewayStatusOptions) => Promise<GatewayStatus | null>;

export function useGatewayStatus() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback<RefreshGatewayStatus>(async ({ showLoading = false } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const res = await authenticatedFetch("/api/gateway/status");
      const data = await res.json();
      setStatus(data);
      return data;
    } catch {
      if (showLoading) setStatus(null);
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus({ showLoading: true });
  }, [fetchStatus]);

  useEffect(() => {
    const state = status?.weixin?.runtime?.state;
    // 需要持续轮询的瞬态：starting/waiting_for_login 覆盖初始扫码流程；
    // expired 覆盖通道自愈流程——通道检测到会话过期后会立即清理凭据并重新发起
    // 扫码登录（waiting_for_login + qrUrl），UI 必须继续轮询才能观察到自愈后的
    // 新二维码，否则会停留在"已过期"提示且不再刷新。failed/stopped 为终态，
    // 保持不轮询（需用户手动操作，见 WeixinChannelSection）。
    if (state !== "starting" && state !== "waiting_for_login" && state !== "expired") {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void fetchStatus();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [fetchStatus, status?.weixin?.runtime?.state]);

  return { status, loading, refresh: fetchStatus };
}

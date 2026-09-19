import { useEffect, useState } from "react";
import { authenticatedFetch } from "../../../../../utils/api";
import type { ModelWindowOverrides } from "../types";

/**
 * 读取引擎的窗口覆盖层（`GET /api/config/model-windows`，issue #449）。
 *
 * 返回 `null` 表示"尚未拿到"（读取中）；读取失败或文件缺失返回 `{}`——
 * 设置页据此退回"未探测"状态，而不是显示一个不确定的值。
 */
export function useModelWindowOverrides(): ModelWindowOverrides | null {
  const [overrides, setOverrides] = useState<ModelWindowOverrides | null>(null);
  useEffect(() => {
    let cancelled = false;
    authenticatedFetch("/api/config/model-windows", { headers: { accept: "application/json" } })
      .then(async res => (res.ok ? await res.json() : null))
      .then(body => {
        if (cancelled) return;
        const entries = body && typeof body === "object" ? (body as { entries?: unknown }).entries : undefined;
        setOverrides(entries && typeof entries === "object" ? (entries as ModelWindowOverrides) : {});
      })
      .catch(() => {
        if (!cancelled) setOverrides({});
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return overrides;
}

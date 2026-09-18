import { authenticatedFetch } from "../../../../utils/api";

/**
 * Skills 面板的 JSON 端点调用：POST + 错误消息归一化。
 *
 * 从 `SkillsV2.tsx` 搬出（#159 UI-APP-N01 切片 A）：面板本体与 `skills/import/`
 * 子组件都依赖它，留在原处会被子组件反向导入形成循环依赖。
 */
export async function api<T>(url: string, body: unknown): Promise<T> {
  const r = await authenticatedFetch(url, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message =
      (data as { error?: string; message?: string }).error ||
      (data as { message?: string }).message ||
      `Request failed (${r.status})`;
    throw new Error(message);
  }
  return data as T;
}

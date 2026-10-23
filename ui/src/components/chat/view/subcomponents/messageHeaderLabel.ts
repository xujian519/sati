import type { useTranslation } from "react-i18next";
import type { Provider } from "../../types/types";

export function resolveHeaderTypeLabel(
  t: ReturnType<typeof useTranslation>["t"],
  messageType: string,
  provider: Provider | string,
): string {
  if (messageType === "error") return t("messageTypes.error");
  if (messageType === "tool") return t("messageTypes.tool");
  if (provider === "cursor") return t("messageTypes.cursor");
  if (provider === "codex") return t("messageTypes.codex");
  if (provider === "gemini") return t("messageTypes.gemini");
  return t("messageTypes.sati");
}

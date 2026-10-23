import type { useTranslation } from "react-i18next";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import type { Provider } from "../../types/types";

function resolveHeaderTypeLabel(
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

export function MessageHeaderRow({
  messageType,
  provider,
  t,
}: {
  messageType: string;
  provider: Provider | string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <div className="mb-2 flex items-center space-x-3">
      {messageType === "error" ? (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">
          !
        </div>
      ) : messageType === "tool" ? (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-600 text-sm text-white dark:bg-gray-700">
          🔧
        </div>
      ) : (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-white">
          <SessionProviderLogo provider={provider} className="h-full w-full" />
        </div>
      )}
      <div className="text-sm font-medium text-gray-900 dark:text-white">
        {resolveHeaderTypeLabel(t, messageType, provider)}
      </div>
    </div>
  );
}

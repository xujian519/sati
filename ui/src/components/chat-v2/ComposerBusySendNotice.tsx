import type { TFunction } from "i18next";

type ComposerBusySendNoticeProps = {
  isBusySendQueued: boolean;
  isBusySendConfirmed: boolean;
  canSteerBusySend: boolean;
  onSteerBusySendQueue?: () => void;
  onCancelBusySendQueue?: () => void;
  t: TFunction<"chat">;
};

export default function ComposerBusySendNotice({
  isBusySendQueued,
  isBusySendConfirmed,
  canSteerBusySend,
  onSteerBusySendQueue,
  onCancelBusySendQueue,
  t,
}: ComposerBusySendNoticeProps) {
  return (
    <>
      {isBusySendQueued ? (
        <div className="hidden min-w-0 flex-1 items-center justify-end gap-1 px-2 text-[12px] text-amber-700 sm:flex dark:text-amber-300">
          <span className="truncate rounded-full bg-amber-50 px-2 py-1 dark:bg-amber-950/30">
            {isBusySendConfirmed
              ? t("input.queuedSendConfirmedInline", { defaultValue: "Stopping current turn; sending next" })
              : t("input.queuedSendConfirmInline", {
                  defaultValue: "Queued; click again to stop this turn and send now",
                })}
          </span>
          {canSteerBusySend && onSteerBusySendQueue ? (
            <button
              type="button"
              onClick={onSteerBusySendQueue}
              className="rounded-full px-2 py-1 text-amber-700 transition hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-950/50"
              title={
                t("input.steerQueuedSend", {
                  defaultValue: "Steer instead — inject into the running turn without stopping it",
                }) as string
              }
            >
              {t("input.steerQueuedSendShort", { defaultValue: "Steer" })}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCancelBusySendQueue}
            className="rounded-full px-2 py-1 text-amber-700 transition hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-950/50"
            title={t("input.cancelQueuedSend", { defaultValue: "Cancel queued message" }) as string}
          >
            {t("input.cancelQueuedSendShort", { defaultValue: "Cancel" })}
          </button>
        </div>
      ) : null}
    </>
  );
}

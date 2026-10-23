const TASK_STATUS_DOT_STYLES: Record<string, string> = {
  completed: "bg-green-500",
  failed: "bg-red-500",
  error: "bg-red-500",
};

export function TaskNotificationRow({
  messageContent,
  formattedTime,
  taskStatus,
  taskId,
}: {
  messageContent: string;
  formattedTime: string;
  taskStatus?: string;
  taskId?: string;
}) {
  return (
    <div className="w-full">
      <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
        <div className="flex items-start gap-2">
          <span
            className={`mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
              TASK_STATUS_DOT_STYLES[taskStatus ?? ""] ?? "bg-amber-500"
            }`}
          />
          <div className="min-w-0 flex-1">
            <div className="break-words text-foreground">{messageContent}</div>
            {(taskStatus || taskId) && (
              <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                {taskStatus && <span className="rounded bg-background/80 px-1.5 py-0.5">{taskStatus}</span>}
                {taskId && <span className="rounded bg-background/80 px-1.5 py-0.5">{taskId}</span>}
              </div>
            )}
          </div>
          <span className="flex-shrink-0 text-xs text-muted-foreground">{formattedTime}</span>
        </div>
      </div>
    </div>
  );
}

export default function PreviewSpinner({ label }: { label?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
      {label && <p className="text-[12px] text-neutral-500 dark:text-neutral-400">{label}</p>}
    </div>
  );
}

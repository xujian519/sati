/** 表单字段外壳：标签 + 内容 + 可选提示（Skills 面板多处共用）。 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-[12px] font-medium text-neutral-700 dark:text-neutral-300">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xxs text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
    </div>
  );
}

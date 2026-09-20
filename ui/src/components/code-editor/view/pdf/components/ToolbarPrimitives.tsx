import type { ReactNode } from "react";

export function ToolbarButton({
  title,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition-colors",
        "hover:bg-neutral-100 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-40",
        "dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50",
        active ? "bg-neutral-100 text-neutral-950 dark:bg-neutral-800 dark:text-neutral-50" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function ToolbarLink({
  title,
  href,
  download,
  children,
}: {
  title: string;
  href: string;
  download?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      download={download}
      title={title}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
    >
      {children}
    </a>
  );
}

export function ToolbarSeparator() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" />;
}

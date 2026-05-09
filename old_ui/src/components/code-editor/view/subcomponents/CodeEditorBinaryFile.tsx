import type { CodeEditorFile } from '../../types/types';

type CodeEditorBinaryFileProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
  isFullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
  title: string;
  message: string;
};

export default function CodeEditorBinaryFile({
  file,
  isSidebar,
  isFullscreen,
  onClose,
  onToggleFullscreen,
  title,
  message,
}: CodeEditorBinaryFileProps) {
  const iconBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

  const binaryContent = (
    <div className="flex h-full w-full flex-col items-center justify-center bg-white p-8 dark:bg-neutral-950">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-900">
          <svg
            className="h-7 w-7 text-neutral-500 dark:text-neutral-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        <div>
          <h3 className="mb-1 text-[14px] font-medium text-neutral-900 dark:text-neutral-100">
            {title}
          </h3>
          <p className="text-[13px] text-neutral-500 dark:text-neutral-400">{message}</p>
        </div>
        <button
          onClick={onClose}
          className="mt-2 rounded-md bg-neutral-900 px-4 py-1.5 text-[13px] text-white transition-colors hover:opacity-90 dark:bg-neutral-100 dark:text-neutral-900"
        >
          Close
        </button>
      </div>
    </div>
  );

  const headerTopBar = (
    <div className="flex flex-shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h3 className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
          {file.name}
        </h3>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {!isSidebar && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className={iconBtn}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.75}
                  d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5"
                />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.75}
                  d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                />
              </svg>
            )}
          </button>
        )}
        <button type="button" onClick={onClose} className={iconBtn} title="Close">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.75}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );

  if (isSidebar) {
    return (
      <div className="flex h-full w-full flex-col bg-white dark:bg-neutral-950">
        {headerTopBar}
        {binaryContent}
      </div>
    );
  }

  const containerClassName = isFullscreen
    ? 'fixed inset-0 z-[9999] bg-white dark:bg-neutral-950 flex flex-col'
    : 'fixed inset-0 z-[9999] md:bg-black/40 md:backdrop-blur-sm md:flex md:items-center md:justify-center md:p-4';

  const innerClassName = isFullscreen
    ? 'bg-white dark:bg-neutral-950 flex flex-col w-full h-full'
    : 'bg-white dark:bg-neutral-950 flex flex-col w-full h-full md:rounded-xl md:border md:border-neutral-200 dark:md:border-neutral-800 md:shadow-xl md:w-full md:max-w-2xl md:h-auto md:max-h-[60vh]';

  return (
    <div className={containerClassName}>
      <div className={innerClassName}>
        {headerTopBar}
        {binaryContent}
      </div>
    </div>
  );
}

import { useCallback, useState, type ErrorInfo, type ReactNode } from "react";
import { ErrorBoundary as ReactErrorBoundary, type FallbackProps } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { reloadUi, recordUiDiagnostic } from "../../../lib/uiDiagnostics";
import { logError } from "../../../utils/logging";

type ErrorFallbackProps = FallbackProps & {
  showDetails: boolean;
  componentStack: string | null;
};

type ErrorBoundaryProps = {
  children: ReactNode;
  showDetails?: boolean;
  onRetry?: () => void;
  resetKeys?: unknown[];
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function ErrorFallback({ error, resetErrorBoundary, showDetails, componentStack }: ErrorFallbackProps) {
  const { t } = useTranslation("common");
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950/40">
        <div className="mb-4 flex items-center">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <h3 className="ml-3 text-sm font-medium text-red-800 dark:text-red-200">{t("uiText.errorTitle")}</h3>
        </div>
        <div className="text-sm text-red-700 dark:text-red-300">
          <p className="mb-2">{t("uiText.chatError")}</p>
          {showDetails && (
            <details className="mt-4">
              <summary className="cursor-pointer font-mono text-xs">{t("uiText.errorDetails")}</summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-red-100 p-2 text-xs dark:bg-red-950">
                {formatError(error)}
                {componentStack}
              </pre>
            </details>
          )}
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            onClick={resetErrorBoundary}
            className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:outline-hidden"
          >
            {t("uiText.tryAgain")}
          </button>
          <button
            type="button"
            onClick={reloadUi}
            className="rounded border border-red-300 px-4 py-2 text-sm text-red-800 hover:bg-red-100 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-950"
          >
            {t("uiText.reloadInterface")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorBoundary({
  children,
  showDetails = false,
  onRetry = undefined,
  resetKeys = undefined,
}: ErrorBoundaryProps) {
  const [componentStack, setComponentStack] = useState<string | null>(null);

  // react-error-boundary v6 types the error as `unknown` (it may not be an Error instance).
  const handleError = useCallback((error: unknown, errorInfo: ErrorInfo) => {
    logError("ErrorBoundary caught an error:", error, errorInfo);
    // 只记 error.name：诊断缓冲不得落 prompt / 正文 / 路径（上游 #568）。
    recordUiDiagnostic("react-boundary", { errorName: error instanceof Error ? error.name : "Error" });
    // Keep component stack for optional debug rendering in fallback UI.
    setComponentStack(errorInfo?.componentStack ?? null);
  }, []);

  const handleReset = useCallback(() => {
    setComponentStack(null);
    onRetry?.();
  }, [onRetry]);

  const renderFallback = useCallback(
    ({ error, resetErrorBoundary }: FallbackProps) => (
      <ErrorFallback
        error={error}
        resetErrorBoundary={resetErrorBoundary}
        showDetails={showDetails}
        componentStack={componentStack}
      />
    ),
    [showDetails, componentStack],
  );

  return (
    <ReactErrorBoundary
      fallbackRender={renderFallback}
      onError={handleError}
      onReset={handleReset}
      resetKeys={resetKeys}
    >
      {children}
    </ReactErrorBoundary>
  );
}

export default ErrorBoundary;

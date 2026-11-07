import type { TestStatus } from "./types";

type TestResultBannerProps = {
  testStatus: TestStatus;
  testMessage: string;
};

export default function TestResultBanner({ testStatus, testMessage }: TestResultBannerProps) {
  if (!testMessage) return null;
  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm ${
        testStatus === "success"
          ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800/40 dark:bg-green-900/10 dark:text-green-300"
          : "border-red-200 bg-red-50 text-red-800 dark:border-red-800/40 dark:bg-red-900/10 dark:text-red-300"
      }`}
    >
      {testStatus === "success" ? "✓ " : "✗ "}
      {testMessage}
    </div>
  );
}

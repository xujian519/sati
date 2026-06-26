import {
  isIgnoredPath,
  normalizeRelativePath,
  runRipgrep,
  splitRipgrepLines,
} from "./ripgrep.js";

const DEFAULT_LIMIT = 1_000;

export type RipgrepFilesInput = {
  cwd: string;
  pattern: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type RipgrepFilesResult = {
  files: string[];
  count: number;
  truncated: boolean;
};

export function normalizeRipgrepGlobPattern(pattern: string): string {
  return pattern.replace(/\\/g, "/");
}

export async function ripgrepFiles(input: RipgrepFilesInput): Promise<RipgrepFilesResult> {
  const stdout = await runRipgrep({
    cwd: input.cwd,
    args: [
      "--files",
      "--hidden",
      "--no-ignore",
      "--glob",
      normalizeRipgrepGlobPattern(input.pattern),
      "--sort=modified",
      ".",
    ],
    env: input.env,
    signal: input.signal,
    toolName: "glob",
  });
  const limit = input.limit ?? DEFAULT_LIMIT;
  const files = splitRipgrepLines(stdout)
    .map(normalizeRelativePath)
    .filter((line) => !isIgnoredPath(line));
  const selected = files.slice(0, limit);
  return {
    files: selected,
    count: files.length,
    truncated: selected.length < files.length,
  };
}

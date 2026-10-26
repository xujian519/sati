/** TTY size properties that ink 8's `NodeJS.WritableStream` stdout type omits. */
export type TerminalSize = Partial<Pick<NodeJS.WriteStream, "columns" | "rows">>;

/**
 * ink 8 types `useStdout().stdout` as `NodeJS.WritableStream`. Streams attached
 * to a terminal still expose `columns`/`rows` at runtime; non-TTY streams
 * (tests, pipes) leave them undefined, so callers keep their own fallbacks.
 */
export function readTerminalSize(stdout: NodeJS.WritableStream | undefined): TerminalSize {
  const stream = stdout as (NodeJS.WritableStream & TerminalSize) | undefined;
  return { columns: stream?.columns, rows: stream?.rows };
}

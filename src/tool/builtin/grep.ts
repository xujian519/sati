import path from "node:path";
import type { PolitDeckToolDefinition } from "../protocol/types.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import { globPatternToRegExp } from "./filesystem/globPattern.js";
import { resolvePolitDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { readTextFile } from "./filesystem/readTextFile.js";
import { walkFiles } from "./filesystem/walk.js";

export type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  outputMode?: "content" | "files_with_matches" | "count";
  before?: number;
  after?: number;
  context?: number;
  caseInsensitive?: boolean;
  headLimit?: number;
  offset?: number;
};

export function createGrepTool(): PolitDeckToolDefinition<GrepInput> {
  return {
    name: "grep",
    aliases: ["Grep"],
    description: "Search workspace text files with a regular expression.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        outputMode: { type: "string", enum: ["content", "files_with_matches", "count"] },
        before: { type: "integer" },
        after: { type: "integer" },
        context: { type: "integer" },
        caseInsensitive: { type: "boolean" },
        headLimit: { type: "integer" },
        offset: { type: "integer" },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolvePolitDeckWorkspacePath(input.path ?? ".", context, { mustExist: true });
      if (!resolved.ok) {
        throw new PolitDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const regex = new RegExp(input.pattern, input.caseInsensitive ? "i" : undefined);
      const globRegex = input.glob ? globPatternToRegExp(input.glob) : undefined;
      const files = (await walkFiles(resolved.absolutePath))
        .map((file) => file.split(path.sep).join("/"))
        .filter((file) => !globRegex || globRegex.test(file))
        .sort();
      const matches: GrepMatch[] = [];

      for (const file of files) {
        const absoluteFile = path.join(resolved.absolutePath, file);
        const content = await readTextFile(absoluteFile).catch(() => undefined);
        if (content === undefined) {
          continue;
        }

        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          regex.lastIndex = 0;
          if (regex.test(line)) {
            matches.push({ file, lineNumber: index + 1, line, lines });
          }
        });
      }

      const mode = input.outputMode ?? "files_with_matches";
      const offset = Math.max(0, input.offset ?? 0);
      const limit = input.headLimit ?? 250;
      const selected = limit === 0 ? matches.slice(offset) : matches.slice(offset, offset + limit);
      const truncated = selected.length < matches.length - offset;
      const workspacePrefix = resolved.relativePath === "." ? "" : `${resolved.relativePath}/`;

      if (mode === "count") {
        const counts = countByFile(matches, workspacePrefix);
        return {
          content: [{ type: "text", text: Object.entries(counts).map(([file, count]) => `${file}:${count}`).join("\n") }],
          data: { mode, files: Object.keys(counts), count: matches.length, truncated: false },
        };
      }

      if (mode === "content") {
        const text = selected.map((match) => formatMatch(match, input, workspacePrefix)).join("\n");
        return {
          content: [{ type: "text", text }],
          data: { mode, files: uniqueFiles(matches, workspacePrefix), count: matches.length, truncated },
          metadata: { truncated },
        };
      }

      const fileList = uniqueFiles(matches, workspacePrefix);
      return {
        content: [{ type: "text", text: fileList.join("\n") }],
        data: { mode, files: fileList, count: matches.length, truncated },
        metadata: { truncated },
      };
    },
  };
}

type GrepMatch = {
  file: string;
  lineNumber: number;
  line: string;
  lines: string[];
};

function uniqueFiles(matches: GrepMatch[], prefix: string): string[] {
  return [...new Set(matches.map((match) => `${prefix}${match.file}`))].sort();
}

function countByFile(matches: GrepMatch[], prefix: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of matches) {
    const file = `${prefix}${match.file}`;
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return counts;
}

function formatMatch(match: GrepMatch, input: GrepInput, prefix: string): string {
  const context = input.context ?? 0;
  const before = input.before ?? context;
  const after = input.after ?? context;
  const start = Math.max(0, match.lineNumber - 1 - before);
  const end = Math.min(match.lines.length, match.lineNumber + after);
  const lines = match.lines.slice(start, end);
  return lines
    .map((line, index) => `${prefix}${match.file}:${start + index + 1}:${line}`)
    .join("\n");
}

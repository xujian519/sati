import path from "node:path";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { globPatternToRegExp } from "./filesystem/globPattern.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { readTextFile } from "./filesystem/readTextFile.js";
import { walkFiles } from "./filesystem/walk.js";

export type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  context?: number;
  "-i"?: boolean;
  head_limit?: number;
  offset?: number;
};

export function createGrepTool(): PilotDeckToolDefinition<GrepInput> {
  return {
    name: "grep",
    aliases: ["Grep"],
    description:
      "Search workspace text files with a regular expression.\n\nUsage:\n- Supports regular expression patterns for matching file contents.\n- Filter searched files with the glob parameter.\n- Output modes: \"content\" shows matching lines, \"files_with_matches\" lists file paths, and \"count\" shows per-file match counts.\n- Use \"-i\" for case-insensitive matching.\n- Use \"-A\", \"-B\", or \"-C\" to include surrounding context lines in content mode.\n- Use head_limit and offset to page through larger result sets.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description: "The regular expression pattern to search for in file contents.",
        },
        path: {
          type: "string",
          description: "File or directory to search within. Defaults to the workspace root.",
        },
        glob: {
          type: "string",
          description: "Glob pattern to filter files (for example '*.ts').",
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            "Output mode: 'content' shows matching lines, 'files_with_matches' lists file paths, and 'count' shows per-file counts. Defaults to 'files_with_matches'.",
        },
        "-B": {
          type: "integer",
          description: "Number of lines to show before each match (content mode only).",
        },
        "-A": {
          type: "integer",
          description: "Number of lines to show after each match (content mode only).",
        },
        "-C": {
          type: "integer",
          description: "Alias for context: number of lines to show before and after each match.",
        },
        context: {
          type: "integer",
          description: "Number of lines to show before and after each match (content mode only).",
        },
        "-i": {
          type: "boolean",
          description: "When true, perform case-insensitive matching.",
        },
        head_limit: {
          type: "integer",
          description: "Maximum number of matches to return. Defaults to 250.",
        },
        offset: {
          type: "integer",
          description: "Skip this many matches before returning results.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.path ?? ".", context, { mustExist: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const regex = new RegExp(input.pattern, input["-i"] ? "i" : undefined);
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

      const mode = input.output_mode ?? "files_with_matches";
      const offset = Math.max(0, input.offset ?? 0);
      const limit = input.head_limit ?? 250;
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
  const context = input.context ?? input["-C"] ?? 0;
  const before = input["-B"] ?? context;
  const after = input["-A"] ?? context;
  const start = Math.max(0, match.lineNumber - 1 - before);
  const end = Math.min(match.lines.length, match.lineNumber + after);
  const lines = match.lines.slice(start, end);
  return lines
    .map((line, index) => `${prefix}${match.file}:${start + index + 1}:${line}`)
    .join("\n");
}

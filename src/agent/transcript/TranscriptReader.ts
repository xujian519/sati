import { readFile } from "node:fs/promises";
import type { AgentTranscriptDiagnostic, AgentTranscriptEntry } from "./TranscriptEntry.js";

export type AgentTranscriptReadResult = {
  entries: AgentTranscriptEntry[];
  diagnostics: AgentTranscriptDiagnostic[];
};

export async function readTranscript(path: string): Promise<AgentTranscriptReadResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        entries: [],
        diagnostics: [
          {
            code: "transcript_missing",
            severity: "warning",
            message: `Transcript ${path} does not exist.`,
          },
        ],
      };
    }
    throw error;
  }

  const entries: AgentTranscriptEntry[] = [];
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isTranscriptEntry(parsed)) {
        entries.push(parsed);
      } else {
        diagnostics.push({
          code: "transcript_entry_invalid",
          severity: "error",
          message: "Transcript entry has an invalid shape.",
          line: index + 1,
        });
      }
    } catch (error) {
      diagnostics.push({
        code: "transcript_line_invalid",
        severity: "error",
        message: error instanceof Error ? error.message : "Transcript line is not valid JSON.",
        line: index + 1,
      });
    }
  }

  entries.sort((left, right) => left.sequence - right.sequence);
  return { entries, diagnostics };
}

function isTranscriptEntry(value: unknown): value is AgentTranscriptEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.type === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.sequence === "number" &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

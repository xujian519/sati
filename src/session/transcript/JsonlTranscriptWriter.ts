import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import {
  classifyDurableMessageEntry,
  type AgentControlBoundaryTranscriptEntry,
  type AgentMessageTranscriptEntry,
  type AgentTranscriptEntry,
  type SessionMetadataValue,
} from "./TranscriptEntry.js";
import type { AgentTranscriptWriter } from "./TranscriptWriter.js";

export type JsonlTranscriptWriterOptions = {
  path: string;
  now?: () => Date;
};

export class JsonlTranscriptWriter implements AgentTranscriptWriter {
  private sequence = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private lastEntryId: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: JsonlTranscriptWriterOptions) {
    this.now = options.now ?? (() => new Date());
  }

  recordAcceptedInput(sessionId: string, turnId: string, messages: CanonicalMessage[]): Promise<void> {
    return this.recordEntry({
      type: "accepted_input",
      ...this.baseEntry(sessionId, turnId),
      messages,
    });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void> {
    const type: AgentMessageTranscriptEntry["type"] = classifyDurableMessageEntry(message);
    return this.recordEntry({
      type,
      ...this.baseEntry(sessionId, turnId),
      message,
    });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): Promise<void> {
    return this.recordEntry({
      type: "turn_result",
      ...this.baseEntry(sessionId, turnId),
      result,
    });
  }

  recordSessionMetadata(sessionId: string, turnId: string, metadata: SessionMetadataValue): Promise<void> {
    return this.recordEntry({
      type: "session_metadata",
      ...this.baseEntry(sessionId, turnId),
      metadata,
    });
  }

  recordControlBoundary(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): Promise<void> {
    return this.recordEntry({
      type: "control_boundary",
      ...this.baseEntry(sessionId, turnId),
      boundary,
    });
  }

  recordEntry(entry: AgentTranscriptEntry): Promise<void> {
    this.sequence = Math.max(this.sequence, entry.sequence);
    this.lastEntryId = entry.entryId ?? this.lastEntryId;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      await appendFile(this.options.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return this.writeChain;
  }

  private baseEntry(
    sessionId: string,
    turnId: string,
  ): Pick<AgentTranscriptEntry, "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"> {
    return {
      sessionId,
      turnId,
      sequence: ++this.sequence,
      createdAt: this.now().toISOString(),
      entryId: randomUUID(),
      parentEntryId: this.lastEntryId,
    };
  }
}

import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../protocol/result.js";
import { classifyDurableMessageEntry, type AgentMessageTranscriptEntry, type AgentTranscriptEntry } from "./TranscriptEntry.js";
import type { AgentTranscriptWriter } from "./TranscriptWriter.js";

export type JsonlTranscriptWriterOptions = {
  path: string;
  now?: () => Date;
};

export class JsonlTranscriptWriter implements AgentTranscriptWriter {
  private sequence = 0;
  private writeChain: Promise<void> = Promise.resolve();
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

  recordEntry(entry: AgentTranscriptEntry): Promise<void> {
    this.sequence = Math.max(this.sequence, entry.sequence);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true });
      await appendFile(this.options.path, `${JSON.stringify(entry)}\n`, "utf8");
    });
    return this.writeChain;
  }

  private baseEntry(sessionId: string, turnId: string): Pick<AgentTranscriptEntry, "sessionId" | "turnId" | "sequence" | "createdAt"> {
    return {
      sessionId,
      turnId,
      sequence: ++this.sequence,
      createdAt: this.now().toISOString(),
    };
  }
}

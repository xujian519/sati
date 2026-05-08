import type { CanonicalMessage } from "../../model/index.js";
import type {
  MemoryDiagnostic,
  MemoryResolver,
  MemoryRetrieveInput,
} from "./MemoryResolver.js";

export type MemoryAttachmentBuilderResult = {
  attachments: CanonicalMessage[];
  diagnostics: MemoryDiagnostic[];
};

/**
 * Build attachment messages from MemoryResolver output. Used by both:
 *   - PromptAssembler input (Phase 6): turn-start memory section
 *   - CompactionEngine.buildPostCompactMessages: post-compact reinjection
 *
 * Failure is non-fatal; diagnostics surface upstream.
 */
export class MemoryAttachmentBuilder {
  constructor(private readonly resolver: MemoryResolver) {}

  async build(input: MemoryRetrieveInput): Promise<MemoryAttachmentBuilderResult> {
    try {
      const result = await this.resolver.retrieve(input);
      if (!result.systemContext || result.systemContext.trim().length === 0) {
        return { attachments: [], diagnostics: result.diagnostics ?? [] };
      }
      const attachments: CanonicalMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `<memory-context>\n${result.systemContext.trim()}\n</memory-context>`,
            },
          ],
        },
      ];
      return { attachments, diagnostics: result.diagnostics ?? [] };
    } catch (error) {
      return {
        attachments: [],
        diagnostics: [
          {
            code: "memory_provider_error",
            severity: "warning",
            message: `MemoryResolver.retrieve failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}

import { defaultPatentWorkers, validateWorkerOutput, WorkerRegistry } from "../../patent/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export type PatentWorkerValidateInput = {
  /** worker 名称（内置目录: patent-technical-analyzer / patent-search-commander / patent-novelty-analyzer / patent-oa-writer / quality_checker）。 */
  workerName: string;
  /** 待校验的 worker 输出文本。 */
  outputText: string;
};

/**
 * `patent_worker_validate` — Worker 输出契约校验工具。
 *
 * 按内置 Worker 契约（defaultPatentWorkers）校验输出中的 requiredFields：
 * 硬性字段缺失 → degraded 标记（不中断）；返回缺失字段清单与判定。
 * 确定性执行，用于专利产物的契约级质量复核。
 */
export function createPatentWorkerValidateTool(): SatiToolDefinition<PatentWorkerValidateInput> {
  const registry = new WorkerRegistry();
  for (const worker of defaultPatentWorkers()) {
    registry.register(worker);
  }

  return {
    name: "patent_worker_validate",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["PatentWorkerValidate", "worker_contract_check"],
    description:
      "Validate a patent worker's output against its declared contract (required fields). " +
      "Missing hard-contract fields mark the output degraded (no interruption). Returns missing " +
      "field lists and the pass/degraded verdict. Registry completeness can be checked separately.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["workerName", "outputText"],
      additionalProperties: false,
      properties: {
        workerName: { type: "string", description: "Worker name from the built-in catalog." },
        outputText: { type: "string", description: "Output text to validate against the contract." },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const worker = registry.get(input.workerName);
      if (!worker) {
        const names = registry
          .list()
          .map(w => w.name)
          .join(", ");
        return {
          content: [
            { type: "text", text: `patent_worker_validate: 未知 worker "${input.workerName}"（可用: ${names}）` },
          ],
        };
      }
      const validation = validateWorkerOutput(worker, input.outputText);
      const verdict = validation.valid ? "通过 ✅" : `降级 ⚠️（${validation.degradationReason ?? "硬性字段缺失"}）`;
      const hard =
        validation.missingHardFields.length > 0
          ? `缺失硬性字段: ${validation.missingHardFields.join("、")}`
          : "硬性字段齐全";
      const soft =
        validation.missingSoftFields.length > 0 ? `缺失软性字段: ${validation.missingSoftFields.join("、")}` : "";
      return {
        content: [
          {
            type: "text",
            text: `patent_worker_validate(${worker.name}): ${verdict}\n${hard}${soft ? `\n${soft}` : ""}`,
          },
        ],
      };
    },
  };
}

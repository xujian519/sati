/**
 * 覆盖矩阵域原子：claim-embodiment-mapper（权利要求-实施例覆盖矩阵，方案 §4.3）。
 *
 * 撰写链路的预检：在 draft_claims 之后、draft_spec 之前，把权利要求草稿逐权项
 * 映射到交底书实施例（claim → features → embodimentRefs），产出矩阵 JSON 供
 * draft-spec 校验"每个特征都有实施例支撑"。
 *
 * 语义边界（评审 P5）：
 *   - 输入含 claims_draft（特征锚点——只喂 source_text/pfe_triples 会让 LLM
 *     自造权利要求，评审 P5-设计2#2）；
 *   - 实施例骨架交叉校验（skeleton.ts）：LLM 引用交底书中不存在的实施例 → 剔除，
 *     缺口由确定性规则推导（embodimentRefs 为空 → 全特征无支撑）；
 *   - parse 失败保留原文不降级（extract 骨架行为）；LLM 调用异常降级（fail-open）。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Atom } from "../../atom.js";
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from "../../handler.js";
import { checkClaimEmbodimentCoverage } from "../../../claim-coverage/coverage-check.js";
import { extractEmbodimentIds } from "../../../claim-coverage/skeleton.js";
import type { ClaimCoverageEntry, ClaimCoverageLevel, ClaimEmbodimentCoverage } from "../../../claim-coverage/types.js";
import { atomicWriteJson } from "../../../persist-utils.js";
import { caseOutputsDir } from "../../../paths.js";
import { callLlm, degraded, parseLlmJson, requireLlm } from "./llm.js";

export const claimEmbodimentMapperAtom: Atom = {
  name: "claim-embodiment-mapper",
  description: "权利要求-实施例覆盖矩阵：LLM 抽取（权项特征 + 实施例引用）+ 骨架交叉校验 + 覆盖缺口检测",
  category: "extract",
  inputSchema: ["source_text", "claims_draft"],
  outputSchema: ["claim_coverage_result"],
};

const MAPPER_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claimId: { type: "string", description: "权利要求编号，如 claim_1（必须来自 claims_draft，不得自造）" },
          features: {
            type: "array",
            items: { type: "string" },
            description: "该权利要求的技术特征（源自 claims_draft 原文）",
          },
          embodimentRefs: {
            type: "array",
            items: { type: "string" },
            description: "支撑实施例编号（embodiment_1，须存在于交底书的「实施例 N」段落）",
          },
        },
        required: ["claimId", "features", "embodimentRefs"],
      },
    },
  },
  required: ["claims"],
} as const;

/** 从 claims_draft 解析权利要求编号集合（行首 "N." / "N、" / "N．"，对齐 claim-chart splitClaimSegments）。 */
function parseClaimNumbers(claimsDraft: string): number[] {
  const numbers: number[] = [];
  for (const line of claimsDraft.split(/\n/)) {
    const m = /^\s*(\d+)[.、．]\s*/.exec(line);
    if (m !== null) numbers.push(Number(m[1]));
  }
  return [...new Set(numbers)];
}

export class ClaimEmbodimentMapperHandler implements StageHandler {
  readonly name = "claim-embodiment-mapper";
  readonly category = "extract" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "claim-embodiment-mapper");
    if (missing) return missing;
    const sourceText = getStateString(state, "source_text").trim();
    const claimsDraft = getStateString(state, "claims_draft").trim();
    if (sourceText.length === 0 || claimsDraft.length === 0) {
      return degraded("claim-embodiment-mapper", "输入为空（source_text / claims_draft 缺失）");
    }

    // 实施例骨架（交底书，确定性正则，不靠 LLM）：交叉校验 LLM 的 embodimentRefs
    const skeleton = new Set(extractEmbodimentIds(sourceText));

    const prompt = [
      "你是专利撰写支持专家。基于技术交底书与权利要求草稿，为每条权利要求建立实施例覆盖矩阵：",
      "- claimId：权利要求编号（claim_1, claim_2, ...），**只允许引用 claims_draft 中实际存在的编号**",
      "- features：该权利要求的技术特征，源自 claims_draft 原文，不得自造",
      "- embodimentRefs：从交底书的「实施例 N」段落中，找到支撑该权项特征的实施例编号（embodiment_1, ...）；",
      "  某权项无任何实施例支撑时输出空数组",
      "",
      "【权利要求草稿】",
      "```",
      claimsDraft.slice(0, 4000),
      "```",
      "【技术交底书】",
      "```",
      sourceText.slice(0, 8000),
      "```",
      "",
      "请严格输出 JSON：{ claims: [{ claimId, features: string[], embodimentRefs: string[] }] }。",
    ].join("\n");

    const res = await callLlm(provider, "claim-embodiment-mapper", prompt, { schema: MAPPER_SCHEMA, temperature: 0 });
    if (!res.ok) return res.error;

    let matrixToPersist: ClaimEmbodimentCoverage | null = null;
    const segment = parseLlmJson(
      res.raw,
      parsed => {
        if (!Array.isArray(parsed.claims)) return null;
        // 空矩阵（评审 I3）：显式标记而非静默"无缺口"——下游据此提示"无数据"而非"全通过"
        if (parsed.claims.length === 0) {
          const empty: ClaimEmbodimentCoverage = { caseId: provider?.caseId ?? "", claims: [], degraded: false };
          matrixToPersist = empty;
          return {
            claim_coverage_result: JSON.stringify({
              ...empty,
              check: checkClaimEmbodimentCoverage(empty),
              claims_empty: true,
            }),
          };
        }
        // 骨架交叉校验（评审 I2）：被剔除的幻觉引用记入 droppedRefs（可见而非静默吞掉）
        const droppedRefs: string[] = [];
        // 评审 M3：按 claimId 去重（保留首条），避免特征重复计入缺口/误报跨权项重复
        const seenClaimIds = new Set<string>();
        const claims: ClaimCoverageEntry[] = parsed.claims
          .filter(
            // 评审 M3：类型谓词补 !Array.isArray（数组元素 typeof === "object" 亦为真）
            (c): c is Record<string, unknown> => c !== null && typeof c === "object" && !Array.isArray(c),
          )
          .map(c => {
            const claimId = typeof c.claimId === "string" ? c.claimId : "";
            const features = Array.isArray(c.features)
              ? c.features.filter((f): f is string => typeof f === "string")
              : [];
            // 骨架交叉校验：引用不存在的实施例剔除（缺口由确定性规则推导）
            const allRefs = Array.isArray(c.embodimentRefs)
              ? c.embodimentRefs.filter((e): e is string => typeof e === "string")
              : [];
            const validRefs: string[] = [];
            for (const ref of allRefs) {
              if (skeleton.has(ref)) validRefs.push(ref);
              else droppedRefs.push(ref);
            }
            const embodimentRefs = [...new Set(validRefs)];
            const uncoveredFeatures = embodimentRefs.length === 0 ? [...features] : [];
            const coverage: ClaimCoverageLevel = embodimentRefs.length > 0 ? "full" : "none";
            return {
              claimId,
              features: [...new Set(features)],
              embodimentRefs,
              coverage,
              uncoveredFeatures,
            };
          })
          .filter(c => c.claimId.length > 0)
          .filter(c => {
            if (seenClaimIds.has(c.claimId)) return false;
            seenClaimIds.add(c.claimId);
            return true;
          });

        const matrix: ClaimEmbodimentCoverage = { caseId: provider?.caseId ?? "", claims, degraded: false };
        matrixToPersist = matrix;
        // 确定性校验（三字段：missingEmbodiment/badClaimIds/duplicateFeatures）并入结果
        const check = checkClaimEmbodimentCoverage(matrix);
        // 评审 I1：claims_draft 锚定——草稿存在但矩阵缺失的编号并入结果（LLM 漏项可见）
        const draftNumbers = parseClaimNumbers(claimsDraft);
        const outputNumbers = new Set(
          claims.map(c => {
            const m = /^claim_(\d+)$/.exec(c.claimId);
            return m === null ? -1 : Number(m[1]);
          }),
        );
        const missingClaims = draftNumbers.filter(n => !outputNumbers.has(n)).map(n => `claim_${n}`);
        return {
          claim_coverage_result: JSON.stringify({
            ...matrix,
            check,
            ...(missingClaims.length > 0 ? { missingClaims } : {}),
            ...(droppedRefs.length > 0 ? { droppedRefs } : {}),
          }),
        };
      },
      // parse 失败：保留原文不降级（extract 骨架行为，评审 P5-设计2#9）
      raw => ({ claim_coverage_result: raw }),
    );
    // 落盘在回调外 await（回调是同步的，fire-and-forget 会在 cwd 变化/进程收尾时丢写）
    if (matrixToPersist !== null && provider?.caseId) {
      await this.persist(matrixToPersist, provider.caseId);
    }
    return segment;
  }

  /** 矩阵落盘（无 caseId 由调用方跳过；失败静默告警 fail-open，对齐 claim-chart 先例）。 */
  private async persist(matrix: ClaimEmbodimentCoverage, caseId: string): Promise<void> {
    try {
      mkdirSync(caseOutputsDir(caseId), { recursive: true });
      await atomicWriteJson(
        join(caseOutputsDir(caseId), "claim-embodiment-coverage.json"),
        JSON.stringify(matrix, null, 2),
      );
    } catch (err) {
      console.error("[claim-embodiment-mapper] 矩阵落盘失败:", err);
    }
  }
}

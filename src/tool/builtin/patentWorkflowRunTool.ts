import {
  builtinPatentManifests,
  runWorkflow,
  validateWorkflowManifest,
  JsonFileWorkflowRunStore,
  type WorkflowManifest,
} from "../../patent/index.js";
import { globalAtomRegistry, globalStageHandlerRegistry, type StageProvider } from "../../patent/atoms/index.js";
import { createNuoSearchProvider } from "../../patent/data/nuo/searchProvider.js";
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_PROVIDER, type CanonicalModelRequest } from "../../model/index.js";
import type { SatiToolDefinition, SatiToolModelClient } from "../protocol/types.js";
import {
  renderWorkflowResultText,
  resolveRunPersistTarget,
  runRuleGate,
  writeRunArtifacts,
} from "./patentWorkflowTool.js";

/**
 * `patent_workflow_run` — 原子自动执行工作流工具。
 *
 * 与 `patent_workflow`（收口语义：主代理产出文本 → 工具收口校验）互补：
 * 本工具**注入 provider 自动执行声明了 atom 的阶段**——LLM（`context.model`
 * 或 deps.model）驱动 extract/merge/groundedness/keywords/novelty/draft-claims，
 * nuo-patent 检索驱动 search；无 atom 阶段（preprocess/report）透传输入文本。
 *
 * 审批门语义：disclosure manifest 的 review_gate 阶段（approval-gate 原子）执行时
 * 抛 InterruptStageError → 工作流**暂停**（返回 interrupted，后续阶段不执行）。
 * 注意：本工具**无断点续跑能力**——再次调用会从零重跑全部阶段并再次在
 * 审批门暂停。人工确认后的 draft_claims 等后续阶段，应由主代理基于
 * interrupted 结果 + 收口语义（patent_workflow 工具）或自定义 manifest 继续。
 *
 * 接线状态（2026-08）：本工具是原子执行路径的唯一生产消费方——此前 10 个内置
 * 原子 handler 与 createNuoSearchProvider 均无生产调用（详见 src/patent/workflow.ts
 * 头注释的"单一路径"原则：收口 + 原子两条路径并存，各有明确消费工具）。
 */

export type PatentWorkflowRunInput = {
  /** 工作流 manifest id（缺省 "patent_disclosure_v1"，唯一声明原子的内置 manifest）。 */
  manifestId?: string;
  /** 案例标识（用于结果记录与持久化；可含 {caseId} 占位）。 */
  caseId?: string;
  /** 初始材料（技术交底书等），映射为各原子读取的 text/source_text/extraction_input。 */
  input: string;
  /** 检索结果上限（缺省 5，透传给 provider.search）。 */
  maxResults?: number;
};

export type PatentWorkflowRunDeps = {
  /** 模型客户端（缺省取 context.model；二者皆无时返回明确错误而非静默降级）。 */
  model?: SatiToolModelClient;
  /** 模型 provider id（缺省 "openrouter"，对齐 web_fetch 默认）。 */
  provider?: string;
  /** 模型 id（缺省 "moonshotai/kimi-k2.6"，对齐 web_fetch 默认）。 */
  modelId?: string;
  /** 检索器（缺省 nuo-patent 的 searchPatents，经 createNuoSearchProvider 适配）。 */
  search?: StageProvider["search"];
  /** 阶段处理器注册表（缺省全局注册表——registerBuiltinAtoms 已装配内置原子）。 */
  handlers?: typeof globalStageHandlerRegistry;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** 收集 stream 事件为完整文本（对齐 web_fetch 二次模型调用模式）。 */
async function collectModelText(model: SatiToolModelClient, request: CanonicalModelRequest): Promise<string> {
  let text = "";
  for await (const event of model.stream(request)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "error":
        throw new Error(`模型调用失败: ${event.error.message}`);
      default:
        break;
    }
  }
  return text;
}

export function createPatentWorkflowRunTool(
  deps: PatentWorkflowRunDeps = {},
): SatiToolDefinition<PatentWorkflowRunInput> {
  const manifests = new Map(builtinPatentManifests.map(({ manifest }) => [manifest.id, manifest]));

  return {
    name: "patent_workflow_run",
    aliases: ["PatentWorkflowRun", "run_patent_atoms"],
    description:
      "Automatically execute a declarative patent workflow's atom stages (extract → merge → groundedness → " +
      "keywords → search → novelty → draft-claims) with an LLM + patent-search provider, instead of collecting " +
      "agent-written stage texts. Built-in atom manifest: patent_disclosure_v1 (PFE extraction → prior-art search → " +
      "per-feature novelty → review gate → claims draft). Provide the disclosure text as 'input'. The review gate " +
      "pauses the run (reports interrupted; later stages do not execute) — re-invoking restarts from scratch and " +
      "pauses again (no checkpoint resume). When caseId is provided the run result and a Mermaid diagram are " +
      "persisted to <caseDir>/workflow-runs/. Requires a model client (session model) and optionally a search provider.",
    kind: "session",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["input"],
      additionalProperties: false,
      properties: {
        manifestId: {
          type: "string",
          description: "Workflow manifest id. Defaults to 'patent_disclosure_v1' (the built-in atom manifest).",
        },
        caseId: {
          type: "string",
          description:
            "Optional case id. When provided, the run result is persisted to <caseDir>/workflow-runs/<runId>.json plus a Mermaid diagram.",
        },
        input: {
          type: "string",
          description: "Initial material (e.g. the technical disclosure text) consumed by the extract atoms.",
        },
        maxResults: {
          type: "number",
          description: "Max prior-art search results (default 5).",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context) {
      // 默认 patent_disclosure_v1：唯一声明原子的内置 manifest（novelty/inventiveness
      // 无 atom，原子执行无意义，应由 patent_workflow 收口语义消费）。
      const manifest: WorkflowManifest | undefined = manifests.get(input.manifestId ?? "patent_disclosure_v1");
      if (!manifest) {
        const available = [...manifests.keys()].join(", ");
        return {
          content: [
            { type: "text", text: `patent_workflow_run: 未知 manifest "${input.manifestId}"（可用: ${available}）` },
          ],
        };
      }
      try {
        validateWorkflowManifest(manifest);
      } catch (err) {
        return {
          content: [{ type: "text", text: `patent_workflow_run: manifest 校验失败: ${(err as Error).message}` }],
        };
      }

      // 模型客户端：deps 优先，否则运行时上下文（AgentLoop 注入）；皆无时明确报错。
      const model = deps.model ?? context.model;
      if (!model) {
        return {
          content: [
            {
              type: "text",
              text: "patent_workflow_run: 未提供模型客户端（context.model 缺失），无法执行原子阶段。请在有模型会话中调用。",
            },
          ],
        };
      }

      // 统一 ctx 映射：各原子输入键（text/source_text/extraction_input）指向同一份输入。
      const workflowCtx = {
        caseId: input.caseId,
        input: input.input,
        text: input.input,
        source_text: input.input,
        extraction_input: input.input,
        max_results: String(input.maxResults ?? 5),
      };

      const provider: StageProvider = {
        callLLM: async (prompt, opts) => {
          const jsonSchema = opts?.jsonSchema;
          const outputSchema =
            jsonSchema !== undefined && typeof jsonSchema === "object" && jsonSchema !== null
              ? { name: "structured_output", schema: jsonSchema as Record<string, unknown>, strict: true }
              : undefined;
          const request: CanonicalModelRequest = {
            provider: deps.provider ?? DEFAULT_MODEL_PROVIDER,
            model: deps.modelId ?? DEFAULT_MODEL_ID,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
            temperature: opts?.temperature ?? 0,
            stream: true,
            ...(outputSchema !== undefined ? { outputSchema } : {}),
          };
          return collectModelText(model, request);
        },
        search: deps.search ?? createNuoSearchProvider().search,
      };

      // 无 atom 阶段（preprocess/report）：透传输入文本（等价"未预处理"），不 degraded。
      const executor = async (): Promise<string> => workflowCtx.input;

      // caseId 持久化（复用收口工具目录约定）：runWorkflow 内 saveRun JSON，执行后补 .mmd。
      const persistTarget = resolveRunPersistTarget(input.caseId, manifest.id, context?.cwd ?? process.cwd());
      const result = await runWorkflow(manifest, workflowCtx, executor, {
        handlers: deps.handlers ?? globalStageHandlerRegistry,
        atoms: globalAtomRegistry,
        provider,
        persist: persistTarget ? new JsonFileWorkflowRunStore(persistTarget.runsDir) : undefined,
        runId: persistTarget?.runId,
      });

      const persistNote = persistTarget
        ? await writeRunArtifacts(persistTarget, manifest, result)
        : "持久化: 未启用（未提供 caseId）";

      const lines = result.stages.map(s => {
        const flag = s.degraded ? "⚠️ 降级" : "✅";
        const preview = s.output.length > 0 ? `${s.output.slice(0, 80)}${s.output.length > 80 ? "…" : ""}` : "(无输出)";
        return `- ${flag} ${s.stageId}${s.atom !== undefined ? ` [atom:${s.atom}]` : ""}: ${preview}`;
      });

      const interruptNote = result.interrupted
        ? `⏸ 审批门暂停: "${result.interrupted.stageId}"（${result.interrupted.message}）——等待人工确认，后续阶段未执行`
        : undefined;

      // 确定性规则门（复用收口工具）：非降级阶段产出拼接文本判级；中断时不跑（产出不完整）。
      const entry = builtinPatentManifests.find(e => e.manifest.id === manifest.id);
      const checkSection =
        result.interrupted === undefined && entry !== undefined ? runRuleGate(result, entry.checkDomains) : "";

      return {
        content: [
          {
            type: "text",
            text: renderWorkflowResultText({
              toolName: "patent_workflow_run",
              result,
              stageLines: lines,
              persistNote,
              checkSection,
              interruptNote,
            }),
          },
        ],
      };
    },
  };
}

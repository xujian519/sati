import { globalStageHandlerRegistry } from "../../../patent/atoms/index.js";
import type { DomainGraphName } from "../../../patent/index.js";
import type { WorkflowProviderDeps } from "../patentWorkflowTool.js";

export type PatentWorkflowRunInput = {
  /** 工作流 manifest id（缺省 "patent_disclosure_v1"；多个内置 manifest 声明 atom，均可自动执行）。 */
  manifestId?: string;
  /**
   * 领域子图模式：命中时走图引擎自动执行对应子图（A22.2 新颖性 / A22.3 创造性 /
   * A26.3 充分公开），一次调用跑完全部节点（LLM + 检索 + 规则门），无需主代理驱动。
   * 缺省走 manifest 路径（向后兼容）。
   */
  graph?: DomainGraphName;
  /** 图模式断点续跑：提供 checkpoint id（上次中断返回）时从该检查点继续。 */
  resumeCheckpointId?: string;
  /**
   * 图模式审批：批准该检查点的审批门（写入放行标记）后从该检查点续跑——
   * 审批门节点重放时检测到标记即放行，后续节点继续执行（真正通过审批门）。
   * 与 resumeCheckpointId 互斥：提供时优先，等价"批准 + 续跑"。
   */
  approveCheckpointId?: string;
  /**
   * manifest 模式审批：已人工批准的审批门阶段 id 列表（如 ["review_gate"]）。
   * 重跑时这些审批门跳过执行直接放行，未批准的照常中断——实现"批准后继续"。
   */
  approveStageIds?: string[];
  /** 案例标识（用于结果记录与持久化；可含 {caseId} 占位）。 */
  caseId?: string;
  /** 初始材料（技术交底书等），映射为各原子读取的 text/source_text/extraction_input。 */
  input: string;
  /**
   * 权利要求书全文（可选，A26.3 enablement 图专用）：单独传入时 enablement/conclude
   * 节点按"权利要求保护的技术方案"判断；缺省回退 input（与 text 相同）。
   */
  claimText?: string;
  /**
   * claim-chart 阶段的目标对象 JSON（[{id,kind,title?,source_path?}]）；缺省为空
   * （只拆分要素，逐行映射留待后续补充）。kind 取值 prior-art（对比文件）/
   * product（被控产品）。
   */
  chartTargets?: string;
  /** 检索结果上限（缺省 5，透传给 provider.search）。 */
  maxResults?: number;
  /**
   * 图模式检索反思回路最大重检次数（缺省 2，0 = 关闭回路保持旧行为）。
   * 覆盖不足时自动换检索式补检，最多重检该次数后放行 closest。
   */
  retrievalRounds?: number;
  /**
   * LLM Judge 双轨质量分（缺省关闭）：>0 时对图模式的结论报告打 0-1 分
   * （N 次采样取中位数），附在结果尾部，不改变规则门判级。
   */
  judgeSamples?: number;
  /**
   * 多模型共识（缺省关闭）：modelHint 名列表（如 ["judge-a","judge-b"]，经
   * deps.modelHints 配置各 hint 的 provider/model）。提供时对结论报告做
   * 多 judge 并行投票 → 中位数 + 离散度分歧检测（spread > 0.25 判 disagree，
   * 结果附"需人工复核"审计标记，不自动挂 HITL）→ 共识判定 + Verdict Envelope
   * （typed verdict 审计：机械规则门
   * 层 + 语义票层 + 共识层，内容哈希防篡改）。缺省走 judgeSamples 单模型路径。
   */
  judgeModels?: string[];
};

/** provider 装配字段（model/provider/modelId/search）单一来源见 patentWorkflowTool 的 WorkflowProviderDeps。 */
export type PatentWorkflowRunDeps = WorkflowProviderDeps & {
  /** 阶段处理器注册表（缺省全局注册表——registerBuiltinAtoms 已装配内置原子）。 */
  handlers?: typeof globalStageHandlerRegistry;
};

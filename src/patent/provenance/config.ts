/**
 * src/patent/provenance — enableProvenance 开关单点（双通道，方案 P6）。
 *
 * 触发条件：程序化配置 `enableProvenance` 优先，回退环境变量 `SATI_PROVENANCE=1`
 * （createLocalGateway 与 patent_workflow_run 工具共用本函数，避免两处独立读取漂移）。
 * 默认关（零开销：不构造 store、不注入 approvalStore）。
 */

export type ProvenanceEnabledOptions = {
  /** 程序化配置（createLocalGateway options）。 */
  enableProvenance?: boolean;
  /** 会话/工具 env（缺省 process.env）。 */
  env?: NodeJS.ProcessEnv;
};

/** 判定决策溯源是否开启。 */
export function isProvenanceEnabled(options: ProvenanceEnabledOptions = {}): boolean {
  const env = options.env ?? process.env;
  return options.enableProvenance ?? env.SATI_PROVENANCE === "1";
}

/**
 * src/patent/docket — 案卷轮次状态机（P0-1 案卷级迭代循环）。
 *
 * - state：纯函数状态机（create/setGapQuestions/triageDocket/recordRevision/finalizeDocket/abandon）；
 * - store：JsonFileDocketStore 持久化 + archiveRevision 修订轮版本留档。
 * 工具接线见 src/tool/builtin/patentDocketTool.ts。
 */

export {
  abandonDocket,
  createDocket,
  DEFAULT_MAX_ROUNDS,
  docketFromJSON,
  docketToJSON,
  DocketError,
  finalizeDocket,
  recordRevision,
  setGapQuestions,
  triageDocket,
  type CreateDocketOptions,
  type DocketPhase,
  type DocketState,
  type GapQuestion,
  type RecordRevisionInput,
  type RevisionRecord,
  type TriageNext,
} from "./state.js";
export {
  archiveRevision,
  JsonFileDocketStore,
  type ArchiveRevisionInput,
  type DocketStore,
} from "./store.js";

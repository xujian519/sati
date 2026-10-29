/** 离线法条快照（law_search 兜底数据源）barrel。 */

export {
  LEGAL_SNAPSHOT_DATA_FILE,
  LEGAL_SNAPSHOT_MANIFEST_FILE,
  LEGAL_SNAPSHOT_SCHEMA_VERSION,
  LegalSnapshotError,
  type LegalSnapshotLaw,
  type LegalSnapshotManifest,
} from "./types.js";
export { LegalSnapshotEngine, SNAPSHOT_UNSUPPORTED_FILTERS } from "./engine.js";
export { candidateLegalSnapshotDirs, resolveLegalSnapshotDir } from "./locate.js";

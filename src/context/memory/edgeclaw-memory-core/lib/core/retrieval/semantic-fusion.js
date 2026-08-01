/**
 * 语义召回与 manifest 的融合（RRF）——从 reasoning-loop 抽离，便于单测。
 *
 * 规则：union = manifest ∪ 语义命中；每个 id 计 RRF 分
 * （manifest rank 与语义 rank 各自 1/(k+rank) 求和）；语义独有命中
 * （超出 manifest 上限 200 的旧文件）也进入候选，由 LLM 决定是否采用。
 */
export const SEMANTIC_SEARCH_LIMIT = 10;
const RRF_K = 60;
export function fuseManifestWithSemantic(manifest, semanticHits) {
    if (semanticHits.length === 0)
        return manifest;
    const manifestById = new Map(manifest.map(entry => [entry.relativePath, entry]));
    const manifestRank = new Map(Array.from(manifestById.keys()).map((id, index) => [id, index]));
    const semanticRank = new Map(semanticHits.map((hit, index) => [hit.relativePath, index]));
    const unionIds = Array.from(new Set([...manifestById.keys(), ...semanticRank.keys()]));
    return unionIds
        .map(id => {
        let rrf = 0;
        const mRank = manifestRank.get(id);
        if (mRank !== undefined)
            rrf += 1 / (RRF_K + mRank + 1);
        const sRank = semanticRank.get(id);
        if (sRank !== undefined)
            rrf += 1 / (RRF_K + sRank + 1);
        return { id, rrf };
    })
        .sort((a, b) => b.rrf - a.rrf)
        .map(item => {
        const entry = manifestById.get(item.id);
        if (entry)
            return entry;
        const hit = semanticHits.find(candidate => candidate.relativePath === item.id);
        return buildSemanticPlaceholder(item.id, hit?.score ?? 0);
    });
}
/** 语义独有命中构造的占位 manifest 条目（LLM 仅见元数据，正文由 id 读取）。 */
function buildSemanticPlaceholder(relativePath, score) {
    return {
        name: relativePath.split("/").pop() ?? relativePath,
        description: `semantic match (score=${score.toFixed(4)})`,
        type: "project",
        scope: "project",
        updatedAt: "",
        file: relativePath,
        relativePath,
        absolutePath: relativePath,
    };
}

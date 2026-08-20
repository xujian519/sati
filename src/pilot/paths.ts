/**
 * 兼容 shim：路径解析实现已迁至 src/shared/paths（P1 shared 收敛）。
 * 仅保留给 ui/server 的纯 JS 移植测试（ui/server/utils/pilotPaths.test.js）引用，
 * src/ 内新代码一律导入 shared/paths。
 * @deprecated 待 ui/server 测试迁移后删除
 */
export * from "../shared/paths/index.js";

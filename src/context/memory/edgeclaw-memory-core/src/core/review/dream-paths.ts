// dream-review 的用户路径守卫（从 dream-review.ts 拆出，G2 聚类，逐字搬移）。
// 用户画像与用户笔记的路径保护语义：这些路径永不被 dream 删除/重写。

export const INTERNAL_USER_PROFILE_RELATIVE_PATH = "UserIdentity/user-profile.md";
export const EXPOSED_USER_PROFILE_RELATIVE_PATH = "global/UserIdentity/user-profile.md";
export const INTERNAL_USER_NOTE_PREFIX = "UserIdentityNotes/";
export const EXPOSED_USER_NOTE_PREFIX = "global/UserIdentityNotes/";

function normalizeDreamRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function isDreamUserProfilePath(relativePath: string): boolean {
  const normalized = normalizeDreamRelativePath(relativePath);
  return normalized === INTERNAL_USER_PROFILE_RELATIVE_PATH || normalized === EXPOSED_USER_PROFILE_RELATIVE_PATH;
}

function isDreamUserNotePath(relativePath: string): boolean {
  const normalized = normalizeDreamRelativePath(relativePath);
  return normalized.startsWith(INTERNAL_USER_NOTE_PREFIX) || normalized.startsWith(EXPOSED_USER_NOTE_PREFIX);
}

export { isDreamUserNotePath, isDreamUserProfilePath, normalizeDreamRelativePath };

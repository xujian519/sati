// file-memory 的路径/默认值常量（从 file-memory.ts 拆出，逐字搬移）。
// TMP_PROJECT_ID / CURRENT_PROJECT_ID 为公共 API（file-memory.ts re-export）。
import { join } from "node:path";

const MANIFEST_FILE = "MEMORY.md";
const PROJECT_META_FILE = "project.meta.md";
const GLOBAL_DIR = "global";
const USER_DIR = "UserIdentity";
const USER_NOTES_DIR = "UserIdentityNotes";
const PROJECT_DIR = "Project";
const FEEDBACK_DIR = "Feedback";
const DEFAULT_USER_PROFILE_RELATIVE_PATH = join(GLOBAL_DIR, USER_DIR, "user-profile.md");
const DEFAULT_PROJECT_NAME = "Current Project";
const DEFAULT_PROJECT_STATUS = "in_progress";

export const TMP_PROJECT_ID = "_tmp";
export const CURRENT_PROJECT_ID = "current_project";

export {
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_STATUS,
  DEFAULT_USER_PROFILE_RELATIVE_PATH,
  FEEDBACK_DIR,
  GLOBAL_DIR,
  MANIFEST_FILE,
  PROJECT_DIR,
  PROJECT_META_FILE,
  USER_DIR,
  USER_NOTES_DIR,
};

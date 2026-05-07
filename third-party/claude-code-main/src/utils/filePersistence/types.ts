export type FilePersistenceConfig = Record<string, unknown>;
export const DEFAULT_UPLOAD_CONCURRENCY = 5;
export const FILE_COUNT_LIMIT = 100;
export const OUTPUTS_SUBDIR = 'outputs';
export type FailedPersistence = { path: string; error: string };
export type FilesPersistedEventData = { count: number; totalBytes: number };
export type PersistedFile = { path: string; size: number; url?: string };
export type TurnStartTime = number;

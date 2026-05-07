export const QUERY_SOURCE = { MAIN: "main", SUBAGENT: "subagent" } as const;
export type QuerySource = typeof QUERY_SOURCE[keyof typeof QUERY_SOURCE];

export type PolitDeckToolInputSchema = {
  type: "object";
  properties?: Record<string, PolitDeckJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type PolitDeckJsonSchema = {
  type?: string | string[];
  properties?: Record<string, PolitDeckJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PolitDeckJsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
};

export type PolitDeckToolValidationIssue = {
  path: string;
  code: "required" | "unknown_property" | "invalid_type" | "invalid_enum" | "invalid_schema";
  message: string;
};

export type PolitDeckToolValidationResult =
  | { ok: true; input: unknown }
  | { ok: false; issues: PolitDeckToolValidationIssue[] };

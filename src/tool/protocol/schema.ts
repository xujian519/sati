export type SatiToolInputSchema = {
  type: "object";
  properties?: Record<string, SatiJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | SatiJsonSchema;
  [key: string]: unknown;
};

export type SatiJsonSchema = {
  type?: string | string[];
  properties?: Record<string, SatiJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | SatiJsonSchema;
  items?: SatiJsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
};

export type SatiToolValidationIssue = {
  path: string;
  code: "required" | "unknown_property" | "invalid_type" | "invalid_enum" | "invalid_schema";
  message: string;
};

export type SatiToolValidationResult = { ok: true; input: unknown } | { ok: false; issues: SatiToolValidationIssue[] };

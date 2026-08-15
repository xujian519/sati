/**
 * 工具 canonical 输出契约校验（阶段四 T9）。
 *
 * 工具在 SatiToolDefinition.outputSchema 声明的 JSON Schema 子集上校验
 * execute 返回的 canonical data（成功路径）。支持：type / required /
 * properties / additionalProperties / items / enum / const / integer。
 * 校验器是纯函数：同一 (data, schema) 两次调用结果严格一致，可安全用于
 * 重放与回归断言。
 */
import type { SatiToolErrorCode } from "../protocol/errors.js";

/** 稳定错误码：canonical 输出违反工具声明的 outputSchema。 */
export const TOOL_OUTPUT_SCHEMA_MISMATCH: SatiToolErrorCode = "tool_output_schema_mismatch";

/** JSON Schema 关键字子集校验器支持的 type 值。 */
const SUPPORTED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesType(value: unknown, type: unknown): boolean {
  if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) return true;
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateAt(value: unknown, schema: unknown, path: string, violations: string[]): void {
  if (!isPlainObject(schema)) return;
  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    if (!schema.enum.some(item => jsonEquals(item, value))) {
      violations.push(path + ": not one of the allowed enum values");
    }
    return;
  }
  if (schema.const !== undefined) {
    if (!jsonEquals(schema.const, value)) {
      violations.push(path + ": does not match the required const value");
    }
    return;
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    violations.push(
      path + ": expected type " + String(schema.type) + ", got " + (value === null ? "null" : typeof value),
    );
    return;
  }
  if (Array.isArray(value)) {
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => {
        validateAt(item, schema.items, path + "[" + index + "]", violations);
      });
    }
    return;
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in value) {
        validateAt(value[key], subSchema, path + "." + key, violations);
      } else if (required.includes(key)) {
        violations.push(path + "." + key + ": missing required property");
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          violations.push(path + "." + key + ": additional property not allowed");
        }
      }
    }
  }
}

/**
 * 校验工具的 canonical 输出值是否满足其 outputSchema 子集。
 *
 * @param value - execute 返回的 data（成功路径的 canonical 值）。
 * @param schema - 工具声明的 outputSchema。
 * @returns 违约路径列表（JSON 指针风格）；空数组表示通过。
 */
export function validateCanonicalOutput(value: unknown, schema: Record<string, unknown>): string[] {
  const violations: string[] = [];
  validateAt(value, schema, "$", violations);
  return violations;
}

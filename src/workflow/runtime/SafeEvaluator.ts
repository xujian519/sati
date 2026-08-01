/**
 * Safe boolean-expression evaluator for workflow step conditions.
 *
 * Adapted from XiaoNuo Agent's `safe-evaluator.ts`. Supports a restricted
 * grammar — comparisons (`== != > < >= <=`), logic (`&& || !`), parentheses,
 * string/number/boolean literals and `{{path}}` context lookups — parsed by a
 * recursive-descent parser. Never touches `eval`/`Function`; a deny-list
 * rejects access to Node globals and dangerous APIs up front.
 */

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\brequire\s*\(/i,
  /\bimport\s*\(/i,
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
  /constructor/i,
  /__proto__/i,
  /prototype/i,
  /child_process/i,
  /node:\w+/i,
  /\bprocess\b/i,
  /\bglobalThis\b/i,
  /\bglobal\b/i,
];

type Token =
  | { kind: "ident"; value: string }
  | { kind: "path"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" };

/** Thrown when an expression fails the security scan or does not parse. */
export class WorkflowConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConditionError";
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (char === "{") {
      // `{{path}}` — a context lookup resolved to its value during parsing.
      if (!input.startsWith("{{", i)) {
        throw new WorkflowConditionError(`Unexpected '{' at position ${i}; use {{path}} for lookups`);
      }
      const end = input.indexOf("}}", i + 2);
      if (end === -1) throw new WorkflowConditionError(`Unterminated {{...}} lookup in "${input}"`);
      const path = input.slice(i + 2, end).trim();
      if (path.length === 0) throw new WorkflowConditionError("Empty {{}} lookup");
      tokens.push({ kind: "path", value: path });
      i = end + 2;
      continue;
    }
    if (char === "}") {
      throw new WorkflowConditionError(`Unexpected '}' at position ${i}; use {{path}} for lookups`);
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      i++;
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) throw new WorkflowConditionError(`Unterminated string literal in "${input}"`);
      tokens.push({ kind: "string", value });
      continue;
    }
    const twoChar = input.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(twoChar)) {
      tokens.push({ kind: "op", value: twoChar });
      i += 2;
      continue;
    }
    if ([">", "<", "!"].includes(char)) {
      tokens.push({ kind: "op", value: char });
      i++;
      continue;
    }
    if (/\d/.test(char)) {
      let value = "";
      while (i < input.length && /[\d.]/.test(input[i]!)) {
        value += input[i]!;
        i++;
      }
      tokens.push({ kind: "number", value: Number(value) });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let value = "";
      while (i < input.length && /[A-Za-z0-9_$.-]/.test(input[i]!)) {
        value += input[i]!;
        i++;
      }
      if (value === "true" || value === "false") {
        tokens.push({ kind: "bool", value: value === "true" });
      } else {
        tokens.push({ kind: "ident", value });
      }
      continue;
    }
    throw new WorkflowConditionError(`Unexpected character '${char}' at position ${i} in "${input}"`);
  }
  return tokens;
}

type ParserState = { tokens: Token[]; pos: number; context: WorkflowConditionContext };

function peek(state: ParserState): Token | undefined {
  return state.tokens[state.pos];
}

function consume(state: ParserState): Token | undefined {
  return state.tokens[state.pos++];
}

function isOp(token: Token | undefined, value: string): boolean {
  return token?.kind === "op" && token.value === value;
}

function parseOr(state: ParserState): boolean {
  let left = parseAnd(state);
  while (isOp(peek(state), "||")) {
    consume(state);
    const right = parseAnd(state);
    left = left || right;
  }
  return left;
}

function parseAnd(state: ParserState): boolean {
  let left = parseNot(state);
  while (isOp(peek(state), "&&")) {
    consume(state);
    const right = parseNot(state);
    left = left && right;
  }
  return left;
}

function parseNot(state: ParserState): boolean {
  if (isOp(peek(state), "!")) {
    consume(state);
    return !parseNot(state);
  }
  return parseComparison(state);
}

function parseComparison(state: ParserState): boolean {
  const left = parsePrimary(state);
  const op = peek(state);
  if (op?.kind === "op" && ["==", "!=", ">", "<", ">=", "<="].includes(op.value)) {
    consume(state);
    const right = parsePrimary(state);
    return applyComparison(op.value, left, right);
  }
  return Boolean(left);
}

function parsePrimary(state: ParserState): unknown {
  const token = consume(state);
  if (!token) throw new WorkflowConditionError("Unexpected end of expression");
  switch (token.kind) {
    case "lparen": {
      const value = parseOr(state);
      const closing = consume(state);
      if (closing?.kind !== "rparen") {
        throw new WorkflowConditionError("Missing closing parenthesis");
      }
      return value;
    }
    case "string":
    case "number":
    case "bool":
      return token.value;
    case "path":
      return lookupPath(state, token.value);
    case "ident":
      return lookupPath(state, token.value);
    case "op":
      throw new WorkflowConditionError(`Unexpected operator '${token.value}'`);
    default:
      throw new WorkflowConditionError(`Unexpected token at position ${state.pos}`);
  }
}

/** Resolve a dot path like `step1.status` or `step1.output.data.count`. */
function lookupPath(state: ParserState, path: string): unknown {
  const segments = path.split(".");
  if (segments.length === 0) throw new WorkflowConditionError(`Empty lookup "${path}"`);
  let current: unknown = state.context;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function applyComparison(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return typeof left === "number" && typeof right === "number" && left > right;
    case "<":
      return typeof left === "number" && typeof right === "number" && left < right;
    case ">=":
      return typeof left === "number" && typeof right === "number" && left >= right;
    case "<=":
      return typeof left === "number" && typeof right === "number" && left <= right;
    default:
      throw new WorkflowConditionError(`Unsupported operator '${op}'`);
  }
}

export type WorkflowConditionContext = Record<string, unknown>;

/**
 * Evaluate a step condition expression to a boolean.
 *
 * @param expression The condition text, e.g. `{{step1.status}} == "completed" && {{step2.output.data.count}} >= 3`
 * @param context Lookup table for `{{path}}` identifiers — the plan's
 *   step-outputs map keyed by step id (`{ [stepId]: { status, output } }`).
 * @throws {@link WorkflowConditionError} on forbidden tokens or parse errors.
 */
export function evaluateConditionExpression(expression: string, context: WorkflowConditionContext): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new WorkflowConditionError("Empty condition expression");
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new WorkflowConditionError(`Forbidden construct in condition: ${pattern.source}`);
    }
  }
  // The `!` operator and `!=` comparison are allowed; reject other lone uses.
  // `!` may precede identifiers, `(`, and `{{` lookups.
  const stripped = trimmed.replace(/!=/g, "").replace(/!\s*[A-Za-z_({]/g, "");
  if (stripped.includes("!")) {
    throw new WorkflowConditionError("Forbidden '!' token outside comparisons/negation");
  }
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    throw new WorkflowConditionError("Empty condition expression");
  }
  const state: ParserState = { tokens, pos: 0, context };
  const result = parseOr(state);
  if (state.pos < state.tokens.length) {
    throw new WorkflowConditionError(`Unexpected trailing tokens at position ${state.pos}`);
  }
  return result;
}

import type { PilotDeckToolValidationIssue } from "../protocol/schema.js";

/**
 * Format validation issues into a human-readable (and LLM-friendly) error
 * message. Modelled after edgeclaw-opc's `formatZodValidationError` so the
 * model sees exactly which parameters are missing, have the wrong type, or
 * are unexpected — enabling effective self-correction on the next turn.
 */
export function formatValidationError(
  toolName: string,
  issues: PilotDeckToolValidationIssue[],
): string {
  const errorParts: string[] = [];

  for (const issue of issues) {
    const param = issue.path.replace(/^\$\.?/, "");
    switch (issue.code) {
      case "required":
        errorParts.push(`The required parameter \`${param}\` is missing`);
        break;
      case "invalid_type":
        errorParts.push(`The parameter \`${param}\` has an invalid type: ${issue.message}`);
        break;
      case "unknown_property":
        errorParts.push(`An unexpected parameter \`${param}\` was provided`);
        break;
      case "invalid_enum":
        errorParts.push(`The parameter \`${param}\` has an invalid value: ${issue.message}`);
        break;
      default:
        errorParts.push(issue.message);
        break;
    }
  }

  if (errorParts.length === 0) {
    return `Tool ${toolName} input is invalid.`;
  }

  const label = errorParts.length > 1 ? "issues" : "issue";
  return `${toolName} failed due to the following ${label}:\n${errorParts.join("\n")}`;
}

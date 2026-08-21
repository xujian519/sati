/**
 * metacognitiveControl — a model self-estimate → control-exit interface.
 *
 * J-Space's metacognitive protocol: ask before/after, force an exit, and make
 * the retry carry the diagnosis. An estimate that selects no action is a
 * comment, not a monitoring act. Confidence/diagnosis are bracket-marked so the
 * parser does not misfire on ordinary prose.
 */

export type MetacognitiveEstimate = "strong" | "thin" | "shaky";

export type MetacognitiveSelfEstimate = {
  tag?: MetacognitiveEstimate;
  diagnosis?: string;
};

const CONFIDENCE_RE = /\[(?:confidence|self-estimate|estimate)\s*:\s*(strong|thin|shaky|confident|unsure|sure)\s*\]/i;
const DIAGNOSIS_RE = /\[(?:diagnosis|diagnostic|because)\s*:\s*([^\]]+)\]/i;

const TAG_MAP: Record<string, MetacognitiveEstimate> = {
  strong: "strong",
  confident: "strong",
  sure: "strong",
  thin: "thin",
  unsure: "thin",
  shaky: "shaky",
};

/**
 * Parse a bracket-marked confidence/diagnosis from assistant text. Returns
 * undefined for both when no tag is present, so the loop terminates normally.
 */
export function parseSelfEstimate(text: string): MetacognitiveSelfEstimate {
  const result: MetacognitiveSelfEstimate = {};
  const confidence = CONFIDENCE_RE.exec(text);
  if (confidence !== null) {
    result.tag = TAG_MAP[confidence[1]!.toLowerCase()] ?? "thin";
  }
  const diagnosis = DIAGNOSIS_RE.exec(text);
  if (diagnosis !== null) {
    result.diagnosis = diagnosis[1]!.trim();
  }
  return result;
}

/** System-prompt fragment instructing the metacognitive protocol. */
export function buildMetacognitivePrompt(): string {
  return [
    "Metacognitive protocol: when you are about to finalize an answer you are not confident in, ",
    "tag it as `[confidence: strong|thin|shaky]` (bracketed, one line, before the final answer). ",
    "When retrying because something went wrong, name the diagnosis in one clause as ",
    "`[diagnosis: <what you think went wrong>]`. A retry that does not carry its diagnosis is ",
    "the same attempt at the same price. An estimate that does not change what you do next was ",
    "a comment, not a monitoring act.",
  ].join("");
}

/**
 * Build a transient retry prompt that carries the model's diagnosis, so the
 * retry is not a blank repetition.
 */
export function buildMetacognitiveRetryPrompt(diagnosis: string | undefined): string {
  const base = "Your previous response flagged low confidence. Reconsider and answer again, fixing the weak step.";
  const withDiagnosis = diagnosis && diagnosis.length > 0 ? `${base}\nYour stated diagnosis: ${diagnosis}` : base;
  return `${withDiagnosis}\nDo not repeat the same reasoning; name what you checked differently this time.`;
}

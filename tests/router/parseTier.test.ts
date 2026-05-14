import test from "node:test";
import assert from "node:assert/strict";
import { parseTier } from "../../src/router/tokenSaver/parseTier.js";

test("parseTier returns lowercase tier from tag when knownTiers are lowercase", () => {
  const result = parseTier("<tier>simple</tier>", ["simple", "complex"]);
  assert.equal(result, "simple");
});

test("parseTier tag path matches uppercase knownTiers case-insensitively", () => {
  const result = parseTier("<tier>SIMPLE</tier>", ["SIMPLE", "COMPLEX"]);
  assert.equal(result, "SIMPLE");
});

test("parseTier trims whitespace inside tag", () => {
  const result = parseTier("<tier> complex </tier>", ["complex"]);
  assert.equal(result, "complex");
});

test("parseTier falls back to substring matching when no tag is present", () => {
  const result = parseTier("I think this is SIMPLE", ["SIMPLE", "COMPLEX"]);
  assert.equal(result, "SIMPLE");
});

test("parseTier returns undefined for unknown tier in tag", () => {
  const result = parseTier("<tier>UNKNOWN</tier>", ["SIMPLE", "COMPLEX"]);
  // tag extracts "unknown" (lowered), not in knownTiers, tag path returns undefined.
  // substring fallback: "unknown" doesn't contain "simple" or "complex" → undefined
  assert.equal(result, undefined);
});

test("parseTier prefers tag match over conflicting substring", () => {
  // The tag says SIMPLE but the full text also contains COMPLEX.
  // With lowercase knownTiers the tag path should win.
  const result = parseTier("<tier>simple</tier> but also complex", ["simple", "complex"]);
  assert.equal(result, "simple");
});

test("parseTier returns undefined when no tier matches at all", () => {
  const result = parseTier("no matching tier here", ["SIMPLE", "COMPLEX"]);
  assert.equal(result, undefined);
});

test("parseTier returns undefined for empty string", () => {
  const result = parseTier("", ["SIMPLE", "COMPLEX"]);
  assert.equal(result, undefined);
});

test("parseTier strips markdown code fences before parsing tag", () => {
  const input = "```xml\n<tier>simple</tier>\n```";
  const result = parseTier(input, ["simple", "complex"]);
  assert.equal(result, "simple");
});

test("parseTier strips code fences for substring fallback path", () => {
  const input = "```\nI think this is COMPLEX\n```";
  const result = parseTier(input, ["SIMPLE", "COMPLEX"]);
  assert.equal(result, "COMPLEX");
});

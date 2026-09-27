// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildFigureAnnotationDocument, type FigureHashAlgo } from "../../../types/annotationReference";
import { isSavedAnnotationStale } from "./useSavedAnnotation";

function savedDocument(sha256: string, hashAlgo?: FigureHashAlgo) {
  return buildFigureAnnotationDocument({
    figure: {
      path: "/w/project/figures/inv-fig1.svg",
      relativePath: "figures/inv-fig1.svg",
      mediaType: "image/svg+xml",
      width: 416,
      height: 141,
      sha256,
      ...(hashAlgo === undefined ? {} : { hashAlgo }),
    },
    marks: [],
  });
}

describe("saved annotation staleness", () => {
  it("is not stale when the digest and the algorithm both match", () => {
    expect(isSavedAnnotationStale(savedDocument("a".repeat(64)), "a".repeat(64), "sha256")).toBe(false);
  });

  it("is stale when the same algorithm yields a different digest", () => {
    expect(isSavedAnnotationStale(savedDocument("a".repeat(64), "fnv1a64"), "b".repeat(16), "fnv1a64")).toBe(true);
  });

  it("reads a document without a recorded algorithm as sha256", () => {
    expect(isSavedAnnotationStale(savedDocument("a".repeat(64)), "a".repeat(64), "sha256")).toBe(false);
    expect(isSavedAnnotationStale(savedDocument("a".repeat(64)), "b".repeat(64), "sha256")).toBe(true);
  });

  it("never reports stale across different algorithms, because the digests are incomparable", () => {
    // 同一份字节在两套算法下摘要必然不同，直接比较会造出假的"图变了"（它还会进提示词）。
    expect(isSavedAnnotationStale(savedDocument("a".repeat(64), "sha256"), "b".repeat(16), "fnv1a64")).toBe(false);
  });
});

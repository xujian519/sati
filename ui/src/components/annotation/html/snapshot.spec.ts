/**
 * 桥接快照的父页侧校验（H2）：消息合法性 + selector 的源解析复核。
 *
 * 桥接输出按不可信数据处理：这里钉住「类型与长度校验」和「源解析命中才保留 selector」两侧行为。
 */
import { describe, expect, it } from "vitest";
import { HTML_ANNOTATION_CHANNEL, HTML_ANNOTATION_MAX_ELEMENTS } from "./constants";
import {
  isHtmlAnnotationSource,
  readHtmlSnapshotMessage,
  type HtmlSnapshot,
  validateSnapshotAgainstSource,
} from "./snapshot";

const expected = { channel: HTML_ANNOTATION_CHANNEL, nonce: "n1" };

function message(overrides: Record<string, unknown> = {}) {
  return {
    channel: HTML_ANNOTATION_CHANNEL,
    nonce: "n1",
    type: "snapshot",
    revision: 1,
    height: 768,
    truncated: false,
    elements: [{ tag: "p", bbox: [0, 0, 10, 10], selector: "body > p:nth-of-type(1)" }],
    ...overrides,
  };
}

describe("readHtmlSnapshotMessage", () => {
  it("pins the channel name (与桥接端必须一致)", () => {
    expect(HTML_ANNOTATION_CHANNEL).toBe("sati-html-annotation");
  });

  it("accepts a well-formed snapshot", () => {
    const snapshot = readHtmlSnapshotMessage(message(), expected);
    expect(snapshot?.elements).toHaveLength(1);
    expect(snapshot?.elements[0]?.selector).toBe("body > p:nth-of-type(1)");
  });

  it("rejects wrong channel / nonce / type", () => {
    expect(readHtmlSnapshotMessage(message({ channel: "x" }), expected)).toBeNull();
    expect(readHtmlSnapshotMessage(message({ nonce: "other" }), expected)).toBeNull();
    expect(readHtmlSnapshotMessage(message({ type: "hello" }), expected)).toBeNull();
  });

  it("rejects malformed numbers, element lists and boxes", () => {
    expect(readHtmlSnapshotMessage(message({ revision: -1 }), expected)).toBeNull();
    expect(readHtmlSnapshotMessage(message({ height: Number.NaN }), expected)).toBeNull();
    expect(readHtmlSnapshotMessage(message({ truncated: "yes" }), expected)).toBeNull();
    expect(readHtmlSnapshotMessage(message({ elements: "nope" }), expected)).toBeNull();
    expect(readHtmlSnapshotMessage(message({ elements: [{ tag: "p", bbox: [0, 0, 10] }] }), expected)).toBeNull();
    expect(
      readHtmlSnapshotMessage(
        message({ elements: [{ tag: "p", bbox: [0, 0, 10, Number.POSITIVE_INFINITY] }] }),
        expected,
      ),
    ).toBeNull();
  });

  it("rejects an element list beyond the shared cap", () => {
    const elements = Array.from({ length: HTML_ANNOTATION_MAX_ELEMENTS + 1 }, () => ({ tag: "p", bbox: [0, 0, 1, 1] }));
    expect(readHtmlSnapshotMessage(message({ elements }), expected)).toBeNull();
  });
});

describe("validateSnapshotAgainstSource", () => {
  const source = `<!doctype html><html><body><div id="top"><p>x</p><span id="s1">y</span></div></body></html>`;

  function snapshotWith(elements: HtmlSnapshot["elements"]): HtmlSnapshot {
    return { revision: 3, height: 100, truncated: false, elements };
  }

  it("keeps selectors that resolve to the same tag and id in the source", () => {
    const validated = validateSnapshotAgainstSource(
      snapshotWith([
        { tag: "p", bbox: [0, 0, 1, 1], selector: "#top > p:nth-of-type(1)" },
        { tag: "span", id: "s1", bbox: [0, 0, 1, 1], selector: "#s1" },
      ]),
      source,
    );
    expect(validated.elements[0]?.selector).toBe("#top > p:nth-of-type(1)");
    expect(validated.elements[0]?.origin).toBe("static");
    expect(validated.elements[1]?.origin).toBe("static");
  });

  it("drops selectors that do not resolve in the source (runtime nodes)", () => {
    const validated = validateSnapshotAgainstSource(
      snapshotWith([{ tag: "button", bbox: [0, 0, 1, 1], selector: "#top > button:nth-of-type(1)" }]),
      source,
    );
    expect(validated.elements[0]?.selector).toBeUndefined();
    expect(validated.elements[0]?.origin).toBe("runtime");
    // 包围盒保留：仍可画，只是不定位。
    expect(validated.elements[0]?.bbox).toEqual([0, 0, 1, 1]);
  });

  it("drops selectors whose resolved element disagrees on tag or id, and invalid syntax", () => {
    const validated = validateSnapshotAgainstSource(
      snapshotWith([
        { tag: "em", bbox: [0, 0, 1, 1], selector: "#top > p:nth-of-type(1)" },
        { tag: "span", id: "other", bbox: [0, 0, 1, 1], selector: "#s1" },
        { tag: "p", bbox: [0, 0, 1, 1], selector: "p:::bogus" },
      ]),
      source,
    );
    expect(validated.elements.map(element => element.origin)).toEqual(["runtime", "runtime", "runtime"]);
    expect(validated.elements.every(element => element.selector === undefined)).toBe(true);
  });

  it("marks elements without a selector as runtime", () => {
    const validated = validateSnapshotAgainstSource(snapshotWith([{ tag: "p", bbox: [0, 0, 1, 1] }]), source);
    expect(validated.elements[0]?.origin).toBe("runtime");
  });
});

describe("isHtmlAnnotationSource", () => {
  it("accepts only the expected window (opaque origin 下 origin 恒为 `null`)", () => {
    const target = {} as Window;
    expect(isHtmlAnnotationSource({ source: target }, target)).toBe(true);
    expect(isHtmlAnnotationSource({ source: {} as Window }, target)).toBe(false);
    expect(isHtmlAnnotationSource({ source: null }, target)).toBe(false);
    expect(isHtmlAnnotationSource({ source: target }, null)).toBe(false);
  });
});

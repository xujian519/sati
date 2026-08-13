/**
 * src/patent/figure — 附图分析核心逻辑测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import {
  analyzePatentFigure,
  buildFigureDescription,
  type FigureAnalysisPhase,
  type FigureModelClient,
} from "../../../src/patent/figure/analyze.js";
import { tryParseJson } from "../../../src/patent/llm-json.js";

const STEP1_JSON = JSON.stringify({
  figure_type: "structure",
  overall_description: "供热管道阴极保护系统用电位采集优化装置的整体结构",
  confidence: 0.9,
  notes: ["管道沿水平方向布置", "多个采集点沿管道分布"],
});

const STEP2_JSON = JSON.stringify({
  components: [
    { ref_number: "1", name: "供热管道", kind: "mechanical", description: "输送热水的管道" },
    { ref_number: "2", name: "电位采集器", kind: "sensor", description: "采集管道电位信号" },
    { ref_number: "3", name: "控制器", kind: "controller", description: "处理采集信号" },
  ],
  connections: [
    { source: "1", target: "2", kind: "mechanical", description: "采集器贴合管道" },
    { source: "2", target: "3", kind: "data_flow", description: "信号传输" },
  ],
  figure_description:
    "图1是本发明实施例提供的供热管道阴极保护系统用电位采集优化装置的结构示意图；图中：1-供热管道；2-电位采集器；3-控制器；",
  warnings: [],
});

/** 构造 fake 模型客户端：按 request.metadata.phase 判别 step1/step2 返回对应 JSON。 */
function fakeModel(
  responder: (phase: FigureAnalysisPhase) => string,
): FigureModelClient & { requests: CanonicalModelRequest[] } {
  const requests: CanonicalModelRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      const phase: FigureAnalysisPhase = request.metadata?.phase === "step2" ? "step2" : "step1";
      yield { type: "text_delta", text: responder(phase) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
}

const BASE_INPUT = {
  imagePath: "fig1.png",
  imageBase64: "aGVsbG8=",
  imageMimeType: "image/png",
  imageBytes: 5,
};

test("analyze_patent_figure: 两步法全流程产出结构化结果", async () => {
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : STEP2_JSON));
  const result = await analyzePatentFigure({ ...BASE_INPUT, claimContext: "1. 一种电位采集装置" }, model);

  assert.equal(result.figureType, "structure");
  assert.equal(result.overallDescription.includes("电位采集优化装置"), true);
  assert.equal(result.components.length, 3);
  assert.equal(result.components[1]?.refNumber, "2");
  assert.equal(result.components[1]?.kind, "sensor");
  assert.equal(result.connections.length, 2);
  assert.equal(result.figureDescription.startsWith("图1是本发明实施例提供的"), true);
  assert.equal(result.usable, true);
  assert.equal(result.modelUsed, "moonshot/kimi-k3");
  assert.equal(model.requests.length, 2);
});

test("analyze_patent_figure: 模型输出带 json 围栏时仍可解析", async () => {
  const model = fakeModel(phase => {
    const body = phase === "step1" ? STEP1_JSON : STEP2_JSON;
    return `好的，结果如下：\n\`\`\`json\n${body}\n\`\`\``;
  });
  const result = await analyzePatentFigure(BASE_INPUT, model);
  assert.equal(result.figureType, "structure");
  assert.equal(result.components.length, 3);
  assert.equal(result.usable, true);
});

test("analyze_patent_figure: Step1 首次非 JSON 时重试成功", async () => {
  let step1Calls = 0;
  const model = fakeModel(phase => {
    if (phase === "step1") {
      step1Calls += 1;
      return step1Calls === 1 ? "这不是 JSON" : STEP1_JSON;
    }
    return STEP2_JSON;
  });
  const result = await analyzePatentFigure(BASE_INPUT, model);
  assert.equal(result.figureType, "structure");
  assert.equal(result.components.length, 3);
  assert.equal(step1Calls, 2, "Step1 应重试一次");
});

test("analyze_patent_figure: 默认不传 temperature（thinking 模型约束）", async () => {
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : STEP2_JSON));
  await analyzePatentFigure(BASE_INPUT, model);
  for (const req of model.requests) {
    assert.equal(req.temperature, undefined, "temperature 应由模型层 thinkingPlan 决定，默认不传");
  }
});

test("analyze_patent_figure: Step1 失败时降级为 unknown、组件可用且保留警告", async () => {
  const model = fakeModel(phase => (phase === "step1" ? "这不是 JSON" : STEP2_JSON));
  const result = await analyzePatentFigure(BASE_INPUT, model);
  assert.equal(result.figureType, "unknown");
  assert.equal(result.components.length, 3);
  // usable 与分类置信度解耦：组件提取成功即可用。
  assert.equal(result.usable, true);
  assert.equal(result.confidence, 0.5, "Step1 失败时置信度为中性值 0.5");
  assert.ok(
    result.warnings.some(w => w.includes("Step1")),
    "应包含 Step1 失败警告",
  );
});

test("analyze_patent_figure: Step2 失败时组件为空且附图说明走兜底模板", async () => {
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : "非 JSON 输出"));
  const result = await analyzePatentFigure({ ...BASE_INPUT, inventionName: "电位采集装置" }, model);
  assert.equal(result.figureType, "structure");
  assert.equal(result.components.length, 0);
  assert.equal(result.figureDescription, "图1是本发明实施例提供的电位采集装置的结构示意图。");
  assert.equal(result.usable, false);
  assert.ok(
    result.warnings.some(w => w.includes("Step2")),
    "应包含 Step2 失败警告",
  );
});

test("analyze_patent_figure: 附图标记不连续时产生警告", async () => {
  const step2 = JSON.parse(STEP2_JSON) as {
    components: Array<{ ref_number: string; name: string; kind: string; description: string }>;
  };
  step2.components = [
    { ref_number: "1", name: "A", kind: "mechanical", description: "" },
    { ref_number: "2", name: "B", kind: "mechanical", description: "" },
    { ref_number: "4", name: "D", kind: "mechanical", description: "" },
  ];
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : JSON.stringify(step2)));
  const result = await analyzePatentFigure(BASE_INPUT, model);
  assert.ok(
    result.warnings.some(w => w.includes("不连续")),
    "应包含标号不连续警告",
  );
});

test("analyze_patent_figure: 连接引用未知组件标号时被过滤", async () => {
  const step2 = JSON.parse(STEP2_JSON) as {
    connections: Array<{ source: string; target: string; kind: string; description: string }>;
  };
  step2.connections.push({ source: "9", target: "2", kind: "electrical", description: "引用未知标号" });
  const model = fakeModel(phase => (phase === "step1" ? STEP1_JSON : JSON.stringify(step2)));
  const result = await analyzePatentFigure(BASE_INPUT, model);
  assert.equal(result.connections.length, 2, "引用未知标号的连接应被过滤");
  assert.ok(!result.connections.some(c => c.source === "9"));
});

test("tryParseJson: 容错解析直接 JSON 与代码围栏（共享模块）", () => {
  assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(tryParseJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(tryParseJson("不是 JSON"), undefined);
});

test("buildFigureDescription: 无组件时生成简式", () => {
  assert.equal(buildFigureDescription(2, "flowchart", undefined, []), "图2是本发明实施例提供的装置的流程图。");
});

/** 按 metadata.phase 精确分发的 mock（区分 step1/step2/repair:xxx）。 */
function phaseAwareModel(
  responder: (phase: string) => string,
): FigureModelClient & { requests: CanonicalModelRequest[] } {
  const requests: CanonicalModelRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(request);
      const phase = String(request.metadata?.phase ?? "step1");
      yield { type: "text_delta", text: responder(phase) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
}

test("JSON 自愈：Step1 重试耗尽后经修复调用成功", async () => {
  const model = phaseAwareModel(phase => {
    if (phase === "step1") return "这不是 JSON";
    if (phase === "repair:step1") return STEP1_JSON;
    return STEP2_JSON;
  });
  const result = await analyzePatentFigure(BASE_INPUT, model);
  assert.equal(result.figureType, "structure");
  assert.equal(result.components.length, 3);

  const repairReq = model.requests.find(r => String(r.metadata?.phase).startsWith("repair:"));
  assert.ok(repairReq, "应存在修复请求");
  const content = repairReq!.messages[0]!.content;
  assert.equal(content.length, 1, "修复请求不附图片，仅一个文本块");
  assert.equal(content[0]!.type, "text");
});

test("JSON 自愈：修复也失败时走既有降级路径", async () => {
  const model = phaseAwareModel(phase => {
    if (phase === "step1") return "这不是 JSON";
    if (phase === "repair:step1") return "还是不是 JSON";
    return STEP2_JSON;
  });
  const result = await analyzePatentFigure(BASE_INPUT, model);
  assert.equal(result.figureType, "unknown");
  assert.ok(
    result.warnings.some(w => w.includes("Step1")),
    "应包含 Step1 失败警告",
  );
});

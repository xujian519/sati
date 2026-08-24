/**
 * src/patent — LLM JSON 容错解析（patent 域共享）。
 *
 * 收敛 atoms（llm.ts）与 figure（analyze.ts）两处重复的 JSON 解析逻辑：
 * 直接解析 → 去 ```json 代码围栏后解析。新增 LLM 结构化输出消费方时复用本模块，
 * 不要复制实现。
 */

/** 去掉 ```json ... ``` 围栏（LLM 输出格式漂移兜底）。 */
export function stripCodeFence(raw: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  return match ? match[1].trim() : raw;
}

/** JSON 容错解析：直接解析 → 去代码围栏解析；失败返回 undefined。 */
export function tryParseJson(raw: string): Record<string, unknown> | undefined {
  const candidates = [raw, stripCodeFence(raw)];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 候选解析失败：尝试下一个候选，全部失败返回 undefined 交由调用方兜底（fail-open）。
    }
  }
  return undefined;
}

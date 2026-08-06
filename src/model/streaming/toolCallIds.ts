/**
 * 工具调用 ID 生成与清洗的共享实现。
 * 各 provider（openai / openai-responses / google）曾各自复制这些函数，
 * 收敛于此以避免行为漂移（如 fallback 前缀不一致）。
 */

/** 生成不冲突的工具调用 ID：优先返回原 ID，冲突时依次追加 `_2`、`_3`… */
export function nextUniqueToolCallId(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    return id;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${id}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** 把任意字符串清洗为安全的工具调用 ID 片段；清洗后为空时回退到 fallback。 */
export function safeToolCallIdPart(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  );
}

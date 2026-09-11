type Path = readonly (string | number)[];

/** 读取容器在首段键上的值；与 `container?.[key]` 语义一致（null/undefined → undefined）。 */
function readAt(container: unknown, key: string | number): unknown {
  if (container === null || container === undefined) return undefined;
  return (container as Record<string | number, unknown>)[key];
}

/** 在容器副本上写入首段键值，返回新容器；数组下标走浅拷贝数组，其余走浅拷贝对象。 */
function writeAt(container: unknown, useArrayKey: boolean, key: string | number, value: unknown): unknown {
  if (useArrayKey) {
    const next = [...(container as unknown[])];
    next[key as number] = value;
    return next;
  }
  return { ...(container as object), [key]: value };
}

export function patch<T>(config: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const useArrayKey = typeof head === "number";
  // SAFETY: 通用深层 patch 以「数组下标 / 对象键」视图读写，容器形状由调用方按 path 决定；
  // 仅在 null/undefined 时按 path 类型回退空容器（与原先 `??` 语义一致）。
  const current: unknown = config ?? (useArrayKey ? [] : {});
  const written =
    rest.length === 0 ? value : patch(readAt(current, head) ?? (typeof rest[0] === "number" ? [] : {}), rest, value);
  return writeAt(current, useArrayKey, head, written) as T;
}

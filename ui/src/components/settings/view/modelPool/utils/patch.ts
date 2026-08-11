type Path = readonly (string | number)[];

export function patch<T>(config: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const isArrayKey = typeof head === "number";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 通用深层 patch：current 需兼容对象/数组两种索引读写，类型化需泛型重载且收益低。
  const current: any = config ?? (isArrayKey ? [] : {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 通用深层 patch：next 需支持 next[head] 读写（数组下标或对象键）。
  const next: any = isArrayKey ? [...(current as unknown[])] : { ...(current as object) };
  next[head as string | number] =
    rest.length === 0
      ? value
      : patch(current?.[head as string | number] ?? (typeof rest[0] === "number" ? [] : {}), rest, value);
  return next as T;
}

/**
 * 输入变化时的防抖校验：picked 模式 50ms、手填路径 400ms，命中 `/api/skills/validate`。
 * 从原组件内的同名 effect 逐行搬出。
 */
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../../shared/api";
import type { PickedFiles, ValidationResult } from "./types";

export function useSkillValidation({
  picked,
  sourcePath,
  setErrorText,
}: {
  picked: PickedFiles;
  sourcePath: string;
  setErrorText: Dispatch<SetStateAction<string | null>>;
}) {
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const validationDebounceRef = useRef<number | undefined>(undefined);

  // Validate on input change. Debounced so typing doesn't hammer the API.
  useEffect(() => {
    if (validationDebounceRef.current) window.clearTimeout(validationDebounceRef.current);
    setErrorText(null);
    if (!picked && !sourcePath.trim()) {
      setValidation(null);
      return;
    }
    setValidating(true);
    validationDebounceRef.current = window.setTimeout(
      async () => {
        try {
          const body = picked ? { skillMdContent: picked.skillMd ?? "", files: picked.manifest } : { sourcePath };
          const r = await api<ValidationResult>("/api/skills/validate", body);
          setValidation(r);
        } catch (e) {
          setValidation(null);
          setErrorText((e as Error).message);
        } finally {
          setValidating(false);
        }
      },
      picked ? 50 : 400,
    );
    return () => {
      if (validationDebounceRef.current) window.clearTimeout(validationDebounceRef.current);
    };
  }, [picked, sourcePath, setErrorText]);

  return { validation, validating, setValidation };
}

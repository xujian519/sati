import { useEffect } from "react";

// Register a window global used by the chat surface (slash commands, debug
// console). Clears it on unmount only when nobody else has overwritten it.
// 经 Reflect 读写：`window` 无可索引签名，下标访问需双重断言；语义等价。
function useWindowGlobal<T>(name: string, value: T) {
  useEffect(() => {
    Reflect.set(window, name, value);
    return () => {
      if (Reflect.get(window, name) === value) {
        Reflect.deleteProperty(window, name);
      }
    };
  }, [name, value]);
}

type UseAppShellGlobalsArgs = {
  refreshProjectsSilently: () => Promise<void>;
  openSettings: () => void;
  switchProject: (projectName: string) => boolean;
};

/** 暴露给聊天面（斜杠命令 / 调试控制台）的 window 全局。 */
export function useAppShellGlobals({ refreshProjectsSilently, openSettings, switchProject }: UseAppShellGlobalsArgs) {
  useWindowGlobal("refreshProjects", refreshProjectsSilently);
  useWindowGlobal("openSettings", openSettings);
  useWindowGlobal("switchProject", switchProject);
}

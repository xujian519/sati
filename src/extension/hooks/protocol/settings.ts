import type { SatiPluginSourceKind } from "../../plugins/protocol/plugin.js";
import type { SatiHookEvent } from "./events.js";

export type SatiHookCommand =
  | {
      type: "command";
      command: string;
      if?: string;
      shell?: "bash" | "powershell";
      statusMessage?: string;
      once?: boolean;
      async?: boolean;
      asyncRewake?: boolean;
      timeout?: number;
    }
  | {
      type: "prompt";
      prompt: string;
      if?: string;
      model?: string;
      statusMessage?: string;
      once?: boolean;
      timeout?: number;
    }
  | {
      type: "http";
      url: string;
      if?: string;
      headers?: Record<string, string>;
      allowedEnvVars?: string[];
      statusMessage?: string;
      once?: boolean;
      timeout?: number;
    }
  | {
      type: "agent";
      prompt: string;
      if?: string;
      model?: string;
      statusMessage?: string;
      once?: boolean;
      timeout?: number;
    }
  | {
      type: "callback";
      name: string;
      if?: string;
      statusMessage?: string;
    };

export type SatiHookMatcher = {
  matcher?: string;
  hooks: SatiHookCommand[];
  pluginName?: string;
  pluginId?: string;
  pluginRoot?: string;
  /**
   * 声明来源。由宿主在拍平插件贡献时填（`loadPluginHooks`），**不从磁盘配置读**——
   * 否则被克隆的仓库可以用 `"source": "builtin"` 自称可信。取 `SatiPluginSourceKind`
   * 是仅类型的反向引用（运行时已擦除，无循环）。
   */
  source?: SatiPluginSourceKind;
};

export type SatiHooksSettings = Partial<Record<SatiHookEvent, SatiHookMatcher[]>>;

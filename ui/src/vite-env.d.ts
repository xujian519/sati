/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IS_PLATFORM?: string;
  readonly VITE_DISABLE_LOCAL_AUTH?: string;
  readonly VITE_CONTEXT_WINDOW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

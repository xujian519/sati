/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IS_PLATFORM?: string;
  readonly VITE_DISABLE_LOCAL_AUTH?: string;
  readonly VITE_ENABLE_HTML_ANNOTATION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

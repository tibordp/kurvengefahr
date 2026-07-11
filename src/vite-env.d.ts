/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Share API base URL. Unset = the share feature is compiled out (see src/share/config.ts). */
  readonly VITE_SHARE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

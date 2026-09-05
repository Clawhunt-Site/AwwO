/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_BOT_USERNAME?: string;
  readonly VITE_TELEGRAM_INIT_DATA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

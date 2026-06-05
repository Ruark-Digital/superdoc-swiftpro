/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the SwiftPro host app (the parent window embedding this iframe).
   * Every inbound postMessage is rejected unless its `event.origin` matches
   * this, and every outbound message is targeted at exactly this origin —
   * never "*". Configured per-environment via .env. Dev default lives in
   * .env.example (http://localhost:5173).
   */
  readonly VITE_HOST_ORIGIN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

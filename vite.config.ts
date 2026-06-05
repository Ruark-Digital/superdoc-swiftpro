import { defineConfig } from "vite";

// This app is embedded by SwiftPro inside a cross-origin <iframe>. The host
// (swifter) defaults its VITE_SUPERDOC_APP_URL to http://localhost:5174, so we
// pin this dev server to 5174 and fail loudly (strictPort) rather than silently
// drifting to another port — a mismatched port breaks the postMessage origin
// handshake.
export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
  },
  preview: {
    port: 5174,
    strictPort: true,
  },
});

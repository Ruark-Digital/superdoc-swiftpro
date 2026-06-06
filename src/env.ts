// Resolves the trusted host origin for the postMessage bridge.
//
// In a production build a missing VITE_HOST_ORIGIN is fatal: without it the app
// would either silently target the wrong origin (handshake dies) or post to
// "undefined". We fail loud at startup instead of shipping a dead editor.
const DEV_HOST_ORIGIN = "http://localhost:5173";

export function resolveHostOrigin(
  env: { VITE_HOST_ORIGIN?: string; PROD: boolean },
): string {
  const value = env.VITE_HOST_ORIGIN?.trim();
  if (value) return value;
  if (env.PROD) {
    throw new Error(
      "VITE_HOST_ORIGIN is not set. The SuperDoc editor app needs the host " +
        "origin (e.g. https://app.swiftpro.tech) to validate and target " +
        "postMessage traffic. Set it as a build-time env var in Amplify.",
    );
  }
  return DEV_HOST_ORIGIN;
}

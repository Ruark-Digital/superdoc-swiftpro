// Resolves the trusted host origin allowlist for the postMessage bridge.
//
// VITE_HOST_ORIGIN may be a single origin or a comma-separated list — one editor
// deployment can be embedded by several host environments (prod, staging,
// preview). Each entry is origin-normalized via `new URL().origin`, which strips
// trailing slashes / paths so a console-entered "https://swiftpro.tech/" still
// matches a `MessageEvent.origin` of "https://swiftpro.tech".
//
// In a production build an empty/invalid value is fatal: without it the app
// would silently reject every host message and post to nowhere. We fail loud at
// startup instead of shipping a dead editor.
const DEV_HOST_ORIGIN = "http://localhost:5173";

export function resolveHostOrigins(
  env: { VITE_HOST_ORIGIN?: string; PROD: boolean },
): string[] {
  const origins = (env.VITE_HOST_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return null;
      }
    })
    .filter((s): s is string => s !== null);

  const unique = Array.from(new Set(origins));
  if (unique.length > 0) return unique;

  if (env.PROD) {
    throw new Error(
      "VITE_HOST_ORIGIN is not set (or has no valid origin). The SuperDoc editor " +
        "app needs the host origin(s) — e.g. https://swiftpro.tech (comma-separate " +
        "multiple) — to validate and target postMessage traffic. Set it as a " +
        "build-time env var in Amplify.",
    );
  }
  return [DEV_HOST_ORIGIN];
}

/**
 * Choose which origin(s) to post the initial (contentless) `superdoc:ready` to.
 *
 * We don't yet know which allowlisted host is embedding us. Prefer the ACTUAL
 * parent origin derived from `document.referrer` (it's in the allowlist) so we
 * post to exactly one origin — no cross-origin "target origin does not match"
 * console warnings. If the referrer is missing/blocked or not allowlisted, fall
 * back to broadcasting to the whole allowlist (the browser delivers only to the
 * matching parent and drops the rest).
 */
export function pickReadyTargets(referrer: string, hostOrigins: string[]): string[] {
  try {
    const parent = referrer ? new URL(referrer).origin : "";
    if (parent && hostOrigins.includes(parent)) return [parent];
  } catch {
    // unparseable referrer — fall through to broadcast
  }
  return hostOrigins;
}

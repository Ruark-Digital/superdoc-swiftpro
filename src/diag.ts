/**
 * TEMPORARY diagnostics for the live-collaboration bug.
 *
 * Symptom under investigation: with two users in the same room the presence
 * avatars flicker, edits from one user don't reach the other, and the remote
 * user's cursor never appears. All three ride the same Yjs channel (the shared
 * doc + the provider's awareness), so the trace records that channel's health:
 *
 *   • connection lifecycle — status transitions, closes, errors, reconnects.
 *     A reconnect loop clears and restores peers (flicker) and drops live
 *     updates.
 *   • awareness — peer count and names on every change. Rapid add/remove churn
 *     is the flicker; a peer whose `user.name` keeps vanishing is why it drops
 *     out of the relayed presence list.
 *   • doc updates — whether a *remote*-origin update ever arrives. If only
 *     local-origin updates are seen, the peers are effectively isolated (edits
 *     never cross), which also means no remote cursor.
 *
 * Active by default in a browser so the deployed build traces with no rebuild;
 * silence with `localStorage.setItem("superdoc:debug","0")` or `?superdocDebug=0`.
 * Never runs outside a browser (no `window`), so unit tests stay silent. Remove
 * once the live-collaboration path is fixed.
 *
 * The trace is cross-origin-safe: DevTools shows iframe console messages in the
 * top frame's console by default. Filter on `superdoc-collab`.
 */

const PREFIX = "[superdoc-collab]";

/** Whether the diagnostic trace should emit. Default ON in the browser. */
export function isDiagEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const ls = window.localStorage?.getItem("superdoc:debug");
    if (ls === "0" || ls === "false") return false;
    if (ls === "1" || ls === "true") return true;
  } catch {
    // localStorage blocked (sandbox / private mode) — fall through.
  }
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has("superdocDebug")) return q.get("superdocDebug") !== "0";
  } catch {
    // Malformed location — ignore.
  }
  return true;
}

/** Emit one diagnostic line. No-op when disabled or not in a browser. */
export function diag(event: string, data?: Record<string, unknown>): void {
  if (!isDiagEnabled()) return;
  try {
    // eslint-disable-next-line no-console
    console.info(PREFIX, event, data ?? {});
  } catch {
    // Console unavailable — nothing else we can do.
  }
}

/** Describe a Yjs update origin for the trace (local edit vs remote provider). */
export function describeOrigin(origin: unknown): string {
  if (origin == null) return "null";
  if (typeof origin === "string") return origin;
  const ctor = (origin as { constructor?: { name?: string } })?.constructor?.name;
  return ctor ?? typeof origin;
}

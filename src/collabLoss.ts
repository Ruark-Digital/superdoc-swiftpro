/**
 * Detects a collaboration connection that is not coming back, so the editor can
 * stop retrying and tell the user instead of silently editing a stale copy.
 *
 * A browser hides the HTTP status of a rejected WebSocket upgrade (a 401 looks
 * like a plain abnormal close, code 1006), so an expired session cannot be told
 * apart from a network drop here. We therefore only report that the connection
 * is lost, and why in terms we can see; the host decides whether it is an
 * expired session (it can probe an authenticated endpoint).
 */

/** Consecutive failed (re)connect attempts, with no successful connect between. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** The backend closes the older socket of a user who connects again with this code. */
export const CLOSE_CODE_REPLACED = 4000;

export type LossReason = "replaced" | "retries-exhausted" | "initial-sync-failed";

export interface LossTracker {
  /** A connection closed or errored. `code` is the WebSocket close code, if any. */
  onFailure(code?: number): void;
  /** The provider connected (resets the failure streak). */
  onConnected(): void;
  /** The very first sync never completed (timeout / error / close). */
  onInitialFailure(): void;
}

export function createLossTracker(
  onLost: (info: { reason: LossReason; attempts: number }) => void,
  max: number = MAX_CONSECUTIVE_FAILURES,
): LossTracker {
  let failures = 0;
  let lost = false;
  const lose = (reason: LossReason) => {
    if (lost) return;
    lost = true;
    onLost({ reason, attempts: failures });
  };
  return {
    onFailure(code) {
      if (code === CLOSE_CODE_REPLACED) {
        lose("replaced");
        return;
      }
      failures += 1;
      if (failures >= max) lose("retries-exhausted");
    },
    onConnected() {
      failures = 0;
    },
    onInitialFailure() {
      failures += 1;
      lose("initial-sync-failed");
    },
  };
}

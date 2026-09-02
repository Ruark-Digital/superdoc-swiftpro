/**
 * TEMPORARY diagnostics for the "blank document body" bug.
 *
 * Symptom under investigation: the document body renders on first open but is
 * blank after a reload/rejoin, while comments and the toolbar still render and
 * the .docx itself fetches fine. Two prior fixes keyed the seed-vs-join decision
 * off the `supereditor` body fragment, yet the blank persists — so we need to
 * see, on a live reload, whether we JOIN a room whose body fragment reports
 * content but paints nothing, or whether the SEED/upgrade path wipes the body
 * that first-open already rendered.
 *
 * This module emits a small, prefixed console trace of exactly those signals.
 *
 *   • Active by default in a browser, so the deployed "bug" build traces with no
 *     rebuild or env flag. It is intentionally low-volume (a handful of lines
 *     per load) — NOT a permanent logger. Remove once the blank path is found.
 *   • Silence it at runtime with `localStorage.setItem("superdoc:debug", "0")`
 *     (in the iframe's context) or the `?superdocDebug=0` query param.
 *   • Never runs outside a browser (no `window`), so unit tests stay silent.
 *
 * The trace is cross-origin-safe: Chrome/Edge DevTools shows iframe console
 * messages in the top frame's console by default. Filter on `superdoc-diag`.
 */

const PREFIX = "[superdoc-diag]";

/** Whether the diagnostic trace should emit. Default ON in the browser. */
export function isDiagEnabled(): boolean {
  // No DOM (unit tests / SSR) → never trace.
  if (typeof window === "undefined") return false;
  try {
    const ls = window.localStorage?.getItem("superdoc:debug");
    if (ls === "0" || ls === "false") return false;
    if (ls === "1" || ls === "true") return true;
  } catch {
    // localStorage can throw in a sandboxed/private context — ignore and fall
    // through to the query-param / default checks.
  }
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has("superdocDebug")) return q.get("superdocDebug") !== "0";
  } catch {
    // Malformed location — ignore.
  }
  return true;
}

/** Emit one diagnostic line. No-op when disabled or when not in a browser. */
export function diag(event: string, data?: Record<string, unknown>): void {
  if (!isDiagEnabled()) return;
  try {
    // eslint-disable-next-line no-console
    console.info(PREFIX, event, data ?? {});
  } catch {
    // Console unavailable — nothing else we can do.
  }
}

/** Minimal ProseMirror-ish document shape we probe for a "did it paint" signal. */
interface ProseMirrorDocLike {
  content?: { size?: number };
  childCount?: number;
  textContent?: string;
}

interface EditorStateLike {
  state?: { doc?: ProseMirrorDocLike };
  view?: { state?: { doc?: ProseMirrorDocLike } };
}

/**
 * Snapshot the editor's *rendered* body so a blank page is visible in the trace:
 * a JOIN/seed that paints nothing shows `childCount: 0` / `textLen: 0` even
 * though the room's body fragment reported content. Fully defensive — any missing
 * accessor or throw resolves to `{ available: false }` rather than crashing.
 */
export function editorBodySnapshot(editor: unknown): Record<string, unknown> {
  const e = editor as EditorStateLike | null;
  if (!e) return { available: false, reason: "no-editor" };
  try {
    const doc = e.state?.doc ?? e.view?.state?.doc;
    if (!doc) return { available: false, reason: "no-doc" };
    return {
      available: true,
      contentSize: doc.content?.size ?? null,
      childCount: doc.childCount ?? null,
      textLen: typeof doc.textContent === "string" ? doc.textContent.length : null,
    };
  } catch {
    return { available: false, reason: "threw" };
  }
}

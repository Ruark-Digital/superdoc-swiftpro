/**
 * Tracked-changes ↔ redline bridge.
 *
 * Maps SuperDoc's tracked changes (Word revisions) to the host's `RedlineSpan`
 * contract and back. All functions are intentionally defensive: a missing
 * editor, a missing change id, or a SuperDoc API throw must never crash the
 * iframe — at worst the operation is a no-op and the error is swallowed.
 *
 * SuperDoc API used (all read from the installed @harbour-enterprises/superdoc
 * v1.38.0 type declarations — see BUILD notes in the task report):
 *   - `superdoc.activeEditor: Editor | null`            — the live editor
 *   - `editor.doc: DocumentApi`                         — high-level doc API
 *   - `editor.doc.trackChanges.list({ in: 'all' })`     — enumerate changes
 *   - `editor.doc.trackChanges.decide({decision,target})` — accept/reject
 *   - `editor.doc.replace({ ref, text }, { changeMode }) ` — set live text
 *   - `editor.doc.selection.current()`                  — caret's activeChangeIds
 *   - `superdoc.navigateTo({kind:'entity',entityType:'trackedChange',entityId})`
 */

import type { Editor, SuperDoc } from "@harbour-enterprises/superdoc";
import type { RedlineKind, RedlineSpan } from "./bridge";

/**
 * One tracked-change item as returned by `editor.doc.trackChanges.list`. We type
 * only the fields we read (the full `TrackChangeInfo`/discovery shape is large
 * and most of it is irrelevant to the redline contract).
 */
interface TrackedChangeItem {
  /** Canonical SuperDoc tracked-change id (alias of `address.entityId`). */
  id: string;
  /** 'insert' | 'delete' | 'replacement' | 'format'. */
  type: string;
  /** Mutation-ready ref string for `doc.replace`. */
  handle?: { ref?: string };
  author?: string;
  date?: string;
  excerpt?: string;
  insertedText?: string;
  deletedText?: string;
}

/**
 * Minimal structural view of the `editor.doc` surface we depend on. Kept narrow
 * so a SuperDoc minor bump that touches unrelated parts of `DocumentApi` does
 * not break our typecheck.
 */
interface DocApiLike {
  trackChanges: {
    list: (input?: { in?: "all" }) => { items?: TrackedChangeItem[] };
    decide: (input: {
      decision: "accept" | "reject";
      target: { id: string };
    }) => unknown;
  };
  replace: (
    input: { ref: string; text: string },
    options?: { changeMode?: "direct" | "tracked" },
  ) => unknown;
  selection: {
    current: (input?: { includeText?: boolean }) => {
      activeChangeIds?: string[];
    };
  };
}

function getDoc(editor: Editor | null): DocApiLike | null {
  if (!editor) return null;
  try {
    // `editor.doc` is a lazily-created getter; reading it can throw if the
    // editor session is torn down. Guard accordingly.
    const doc = (editor as unknown as { doc?: unknown }).doc;
    return (doc as DocApiLike) ?? null;
  } catch {
    return null;
  }
}

/**
 * Map a SuperDoc tracked-change `type` to the host's two-value `RedlineKind`.
 * Word/SuperDoc model `replacement` (a delete+insert pair) and `format`
 * changes too; the host only distinguishes insertion vs deletion, so we fold:
 *   - 'insert'                 → "insertion"
 *   - 'delete'                 → "deletion"
 *   - 'replacement' / 'format' → "insertion" (the live text it introduces)
 * Returns null for unknown types so the caller can skip them.
 */
function toRedlineKind(type: string): RedlineKind | null {
  if (type === "delete") return "deletion";
  if (type === "insert" || type === "replacement" || type === "format") {
    return "insertion";
  }
  return null;
}

/**
 * Pure mapper: a single tracked-change list item → a `RedlineSpan`, or null if
 * the item has no usable id/kind. Exported for unit testing (no editor needed).
 */
export function trackedChangeToSpan(item: TrackedChangeItem): RedlineSpan | null {
  if (!item || typeof item.id !== "string" || item.id.length === 0) return null;
  const kind = toRedlineKind(item.type);
  if (!kind) return null;

  // Prefer the kind-specific text, fall back to the excerpt, then empty string.
  const text =
    (kind === "deletion" ? item.deletedText : item.insertedText) ??
    item.excerpt ??
    "";

  const span: RedlineSpan = { redlineId: item.id, kind, text };
  if (typeof item.author === "string") span.author = item.author;
  if (typeof item.date === "string") span.createdAt = item.date;
  return span;
}

/**
 * Extract all tracked changes from the editor as `RedlineSpan[]`.
 *
 * De-dupes by `redlineId` (mirrors the host's `redlineScan.ts`): SuperDoc's
 * list is already keyed by logical change id, but a replacement pair or a
 * multi-segment change can surface the same id twice — keep the first.
 *
 * Always returns an array (empty on any failure) so callers can post
 * unconditionally.
 */
export function extractRedlines(editor: Editor | null): RedlineSpan[] {
  const doc = getDoc(editor);
  if (!doc) return [];

  let items: TrackedChangeItem[];
  try {
    // `in: 'all'` = body + headers + footers + notes (every revision-capable
    // story), so a change in a header still reaches the host sidebar.
    items = doc.trackChanges.list({ in: "all" }).items ?? [];
  } catch {
    return [];
  }

  const byId = new Map<string, RedlineSpan>();
  for (const item of items) {
    const span = trackedChangeToSpan(item);
    if (span && !byId.has(span.redlineId)) byId.set(span.redlineId, span);
  }
  return [...byId.values()];
}

/**
 * Apply a host `apply-redline` command: make `replacement` the live text of the
 * tracked change `redlineId`, then clear any residual tracking.
 *
 * Strategy (see task report for the rejected alternatives):
 *   1. `doc.replace({ ref, text: replacement }, { changeMode: 'direct' })`
 *      sets the final text directly — `direct` avoids spawning a *new* tracked
 *      change for our own substitution.
 *   2. `doc.trackChanges.decide({ decision: 'accept', target: { id } })`
 *      accepts the original change so nothing stays pending. This is
 *      best-effort cleanup: after the direct replace the original marks may
 *      already be gone, in which case decide is a harmless no-op.
 *
 * No-op (and swallows errors) if the editor, the change id, or its ref is
 * missing — never corrupt the document on bad input.
 */
export function applyRedline(
  editor: Editor | null,
  redlineId: string,
  replacement: string,
): void {
  const doc = getDoc(editor);
  if (!doc || typeof redlineId !== "string" || redlineId.length === 0) return;

  let ref: string | undefined;
  try {
    const items = doc.trackChanges.list({ in: "all" }).items ?? [];
    ref = items.find((it) => it.id === redlineId)?.handle?.ref;
  } catch {
    return;
  }
  if (!ref) return; // change not found — defensive no-op.

  try {
    doc.replace({ ref, text: replacement }, { changeMode: "direct" });
  } catch {
    // If the direct replace failed, do not attempt the accept — leave the doc
    // as-is rather than half-applying.
    return;
  }

  try {
    doc.trackChanges.decide({ decision: "accept", target: { id: redlineId } });
  } catch {
    // Residual-tracking cleanup is best-effort; the replace above already made
    // `replacement` the live text, which satisfies the host contract.
  }
}

/**
 * Focus a tracked change: scroll it into view and select/highlight it.
 *
 * Uses the SuperDoc-level `navigateTo` (story-aware, the documented entry point
 * for tracked-change navigation) rather than reaching into PM positions.
 * No-op on missing instance/id.
 */
export function focusRedline(superdoc: SuperDoc | null, redlineId: string): void {
  if (!superdoc || typeof superdoc.navigateTo !== "function") return;
  if (typeof redlineId !== "string" || redlineId.length === 0) return;
  try {
    // `navigateTo` returns a Promise; we fire-and-forget — focus is non-critical.
    void superdoc.navigateTo({
      kind: "entity",
      entityType: "trackedChange",
      entityId: redlineId,
    });
  } catch {
    // Navigation is non-critical; swallow.
  }
}

/**
 * Read the tracked-change id under the current caret/selection, if any.
 *
 * Used by the `selectionUpdate` handler in main.ts to emit `redline-clicked`
 * when the user clicks inside a tracked change. `activeChangeIds` uses union
 * semantics; we report the first id (the host highlights one change at a time).
 * Returns null when the caret is not inside any tracked change.
 */
export function activeRedlineId(editor: Editor | null): string | null {
  const doc = getDoc(editor);
  if (!doc) return null;
  try {
    const ids = doc.selection.current().activeChangeIds ?? [];
    return ids.length > 0 ? ids[0] : null;
  } catch {
    return null;
  }
}

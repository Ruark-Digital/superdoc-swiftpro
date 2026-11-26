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
    /** Single change with its full inserted/deleted text (optional: older builds). */
    get?: (input: { id: string }) => TrackedChangeItem | null | undefined;
    decide: (input: {
      decision: "accept" | "reject";
      target: { id: string };
    }) => unknown;
  };
  replace: (
    input: { target?: unknown; ref?: string; text: string },
    options?: { changeMode?: "direct" | "tracked" },
  ) => unknown;
  /**
   * Text match. Each text match carries a canonical, mutation-ready `target`
   * (`SelectionTarget`) that `replace` accepts directly — the supported way to
   * turn a tracked change's live text into a replaceable range (the change's
   * own entity ref is rejected as a mutation target). The result is a
   * DiscoveryOutput; the target's exact nesting varies by SuperDoc version, so
   * callers read it defensively.
   */
  query?: {
    match: (selector: {
      type: "text";
      pattern: string;
      caseSensitive?: boolean;
    }) => unknown;
  };
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
  if (item.type === "replacement") {
    const deleted = item.deletedText ?? "";
    // The list may omit insertedText and only give the concatenated excerpt
    // (deleted + inserted); recover the inserted part from it.
    const inserted =
      item.insertedText ??
      (deleted && item.excerpt?.startsWith(deleted)
        ? item.excerpt.slice(deleted.length)
        : undefined);
    if (deleted && inserted) {
      span.deletedText = deleted;
      span.insertedText = inserted;
      span.text = inserted;
    }
  }
  if (typeof item.author === "string") span.author = item.author;
  if (typeof item.date === "string") span.createdAt = item.date;
  return span;
}

/**
 * A replacement's list item can omit `insertedText` / `deletedText` and carry
 * only a truncated, concatenated `excerpt` ("RemoOnsi" for Remote → Onsite).
 * Ask for the single change, which carries the two halves in full; if it cannot,
 * the item is returned unchanged.
 */
function withFullTexts(doc: DocApiLike, item: TrackedChangeItem): TrackedChangeItem {
  if (item.type !== "replacement") return item;
  if (item.insertedText && item.deletedText) return item;
  try {
    const full = doc.trackChanges.get?.({ id: item.id });
    if (!full) return item;
    return {
      ...item,
      insertedText: item.insertedText ?? full.insertedText,
      deletedText: item.deletedText ?? full.deletedText,
    };
  } catch {
    return item;
  }
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
    const span = trackedChangeToSpan(withFullTexts(doc, item));
    if (span && !byId.has(span.redlineId)) byId.set(span.redlineId, span);
  }
  return [...byId.values()];
}

/**
 * Pull the first mutation-ready selection `target` out of a `find` result. The
 * shape differs across SuperDoc versions — DiscoveryOutput exposes `items[]`
 * (each `context.target`), the lower-level QueryResult a parallel `context[]` —
 * so probe both defensively.
 */
function firstMatchTarget(found: unknown): unknown {
  if (!found || typeof found !== "object") return undefined;
  const f = found as {
    items?: Array<{
      target?: unknown;
      domain?: { target?: unknown };
      context?: { target?: unknown };
    }>;
    context?: Array<{ target?: unknown }>;
  };
  if (Array.isArray(f.items)) {
    for (const it of f.items) {
      const t = it?.target ?? it?.domain?.target ?? it?.context?.target;
      if (t) return t;
    }
  }
  if (Array.isArray(f.context)) {
    for (const c of f.context) if (c?.target) return c.target;
  }
  return undefined;
}

export type ApplyRedlineResult =
  | { ok: true }
  | {
      ok: false;
      /** Why nothing changed, so the host can tell the user instead of showing a
       *  suggestion as resolved while the document is untouched. */
      reason:
        | "no-editor"
        | "not-found"
        | "no-text"
        | "no-target"
        | "resolve-failed"
        | "replace-failed";
    };

/**
 * Find the live text range of `pattern` (a mutation-ready target), or undefined.
 */
function findTarget(doc: DocApiLike, pattern: string): unknown {
  try {
    return firstMatchTarget(
      doc.query?.match({ type: "text", pattern, caseSensitive: true }),
    );
  } catch {
    return undefined;
  }
}

/**
 * Apply a host `apply-redline` command as a CLEAN swap: the approved
 * `replacement` ends up as plain text in place of the suggested change, with no
 * leftover struck-through deletion or tracked insertion.
 *
 * Why the order matters: SuperDoc force-tracks ANY edit that touches an existing
 * tracked change, even a "direct" one (the editor protects review state; see
 * `transactionTouchesTrackedReviewState` in its dispatch). Replacing the text
 * while it is still a tracked change therefore yields a tracked deletion plus a
 * tracked insertion, whatever the editing mode. So:
 *   1. locate the change's text (pre-check, nothing modified if it is missing);
 *   2. RESOLVE the tracked change first: accept an insertion / replacement (its
 *      text becomes plain, the deleted part is gone) or reject a deletion (the
 *      struck text is restored to plain);
 *   3. direct-replace the now-plain text with the approved text. Plain text
 *      carries no review state, so this is not tracked.
 *
 * Returns why nothing happened rather than failing silently.
 */
export function applyRedline(
  editor: Editor | null,
  redlineId: string,
  replacement: string,
): ApplyRedlineResult {
  const doc = getDoc(editor);
  if (!doc || typeof redlineId !== "string" || redlineId.length === 0) {
    return { ok: false, reason: "no-editor" };
  }

  let matched: TrackedChangeItem | undefined;
  try {
    const items = doc.trackChanges.list({ in: "all" }).items ?? [];
    matched = items.find((it) => it.id === redlineId);
  } catch {
    return { ok: false, reason: "no-editor" };
  }
  if (!matched) return { ok: false, reason: "not-found" }; // change is gone from this document

  // The text that remains (insertion / replacement) or was struck (deletion).
  const isDeletion = matched.type === "delete";
  const span = trackedChangeToSpan(withFullTexts(doc, matched));
  // A replacement whose halves are still unknown only has the glued, truncated
  // excerpt, which never matches the document: say so instead of searching it.
  if (matched.type === "replacement" && span && !span.insertedText) {
    return { ok: false, reason: "no-text" };
  }
  const searchText = isDeletion
    ? (matched.deletedText ?? matched.excerpt ?? "")
    : (span?.text ?? "");
  if (searchText.length === 0) return { ok: false, reason: "no-text" };

  // 1. Pre-check: never touch the document if the text cannot be located.
  if (!findTarget(doc, searchText)) return { ok: false, reason: "no-target" };

  // 2. Resolve the tracked change so its text is plain.
  try {
    doc.trackChanges.decide({
      decision: isDeletion ? "reject" : "accept",
      target: { id: redlineId },
    });
  } catch {
    return { ok: false, reason: "resolve-failed" };
  }

  // 3. Replace the now-plain text. Re-resolve the target: positions moved when
  //    the change was resolved.
  const target = findTarget(doc, searchText);
  if (!target) return { ok: false, reason: "no-target" };
  try {
    doc.replace({ target, text: replacement }, { changeMode: "direct" });
  } catch {
    return { ok: false, reason: "replace-failed" };
  }
  return { ok: true };
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

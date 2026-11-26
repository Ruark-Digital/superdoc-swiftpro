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
  /** The other half of a delete + insert pair, when SuperDoc lists them apart. */
  pairedWithChangeId?: string | null;
  grouping?: string;
}

/** Per-run view of the document, the source of truth for each half's text. */
interface ExtractBlockLike {
  textSpans?: Array<{
    text: string;
    trackedChanges?: Array<{ entityId: string; type: string }>;
  }>;
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
  extract?: (input?: Record<string, never>) => { blocks?: ExtractBlockLike[] };
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
  let out = item;
  try {
    const full = doc.trackChanges.get?.({ id: item.id });
    if (full) {
      out = {
        ...item,
        insertedText: item.insertedText ?? full.insertedText,
        deletedText: item.deletedText ?? full.deletedText,
      };
    }
  } catch {
    /* fall through to the per-run view */
  }
  if (out.insertedText && out.deletedText) return out;
  // The per-run view tags every run with the change it belongs to and whether it
  // is the inserted or the deleted half: join each half in document order.
  try {
    let inserted = "";
    let deleted = "";
    for (const block of doc.extract?.({})?.blocks ?? []) {
      for (const span of block.textSpans ?? []) {
        for (const tc of span.trackedChanges ?? []) {
          if (tc.entityId !== item.id) continue;
          if (tc.type === "insert") inserted += span.text;
          else if (tc.type === "delete") deleted += span.text;
        }
      }
    }
    out = {
      ...out,
      insertedText: out.insertedText ?? (inserted || undefined),
      deletedText: out.deletedText ?? (deleted || undefined),
    };
  } catch {
    /* leave as is */
  }
  return out;
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
  | {
      ok: true;
      /** The change was already gone and the approved text is present. */
      alreadyApplied?: true;
    }
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
      /** The underlying error, for diagnosis from the host side. */
      detail?: string;
    };

/** Minimal ProseMirror surface for the state-level fallback swap. */
type PmMark = { attrs?: { id?: unknown } };
type PmNode = {
  isText?: boolean;
  isTextblock?: boolean;
  isLeaf?: boolean;
  text?: string;
  marks?: PmMark[];
  descendants: (f: (node: PmNode, pos: number) => boolean | void) => void;
};
type StateEditor = {
  state?: {
    doc: PmNode;
    tr: { insertText: (text: string, from: number, to: number) => unknown };
  };
  dispatch?: (tr: unknown) => void;
  view?: { dispatch?: (tr: unknown) => void };
};

/** Every occurrence of `pattern` as absolute document positions, per text block. */
function findTextRanges(root: PmNode, pattern: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  root.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let text = "";
    const positions: number[] = [];
    block.descendants((node, pos) => {
      if (node.isText && node.text) {
        for (let i = 0; i < node.text.length; i += 1) {
          text += node.text[i];
          positions.push(blockPos + 1 + pos + i);
        }
      } else if (node.isLeaf) {
        text += "￼"; // a non-text leaf breaks a match
        positions.push(-1);
      }
      return true;
    });
    for (let i = text.indexOf(pattern); i >= 0; i = text.indexOf(pattern, i + 1)) {
      out.push({ from: positions[i], to: positions[i + pattern.length - 1] + 1 });
    }
    return false;
  });
  return out;
}

/** Start position of the text carrying this tracked change's mark, if any. */
function changeAnchor(root: PmNode, redlineId: string): number | undefined {
  let anchor: number | undefined;
  root.descendants((node, pos) => {
    if (anchor !== undefined) return false;
    if (node.isText && node.marks?.some((m) => m.attrs?.id === redlineId)) anchor = pos;
    return true;
  });
  return anchor;
}

/**
 * Fallback swap at the editor-state level, used only when the document API's
 * `replace` throws: replace the occurrence of `searchText` nearest `anchor`.
 * Runs after the change was resolved, so the text is plain and the edit is not
 * tracked (outside suggesting mode).
 */
function replaceViaState(
  editor: Editor,
  searchText: string,
  replacement: string,
  anchor: number | undefined,
): boolean {
  const ed = editor as unknown as StateEditor;
  const state = ed.state;
  const dispatch = ed.dispatch?.bind(ed) ?? ed.view?.dispatch?.bind(ed.view);
  if (!state || !dispatch) return false;
  const ranges = findTextRanges(state.doc, searchText).filter((r) => r.from >= 0);
  if (ranges.length === 0) return false;
  const at = anchor ?? ranges[0].from;
  const best = ranges.reduce((a, b) => (Math.abs(b.from - at) < Math.abs(a.from - at) ? b : a));
  dispatch(state.tr.insertText(replacement, best.from, best.to));
  return true;
}

/** Accept tracked changes our own swap created (e.g. when suggesting mode tracked it). */
function acceptNewChanges(doc: DocApiLike, before: Set<string>): void {
  try {
    for (const it of doc.trackChanges.list({ in: "all" }).items ?? []) {
      if (!before.has(it.id)) doc.trackChanges.decide({ decision: "accept", target: { id: it.id } });
    }
  } catch {
    /* best effort */
  }
}

const decisionFailed = (receipt: unknown): boolean =>
  typeof receipt === "object" &&
  receipt !== null &&
  (receipt as { success?: unknown }).success === false;

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
  if (!matched) {
    // The change is gone. When both sides approve, the first side's apply syncs
    // here before this side's own apply runs, so the document already holds the
    // approved text (N9): that is applied, not a failure.
    if (replacement.trim() && findTarget(doc, replacement)) {
      console.info("[redlines] apply", { id: redlineId, outcome: "already-applied" });
      return { ok: true, alreadyApplied: true };
    }
    return { ok: false, reason: "not-found" };
  }

  // Diagnostic for field debugging: how SuperDoc describes this change.
  console.info("[redlines] apply", {
    id: redlineId,
    type: matched.type,
    grouping: matched.grouping,
    pairedWithChangeId: matched.pairedWithChangeId,
    insertedText: matched.insertedText,
    deletedText: matched.deletedText,
    excerpt: matched.excerpt,
  });

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

  // Where the change sits, so a fallback swap picks the right occurrence.
  let anchor: number | undefined;
  try {
    const root = (editor as unknown as StateEditor).state?.doc;
    if (root) anchor = changeAnchor(root, redlineId);
  } catch {
    anchor = undefined;
  }

  // 2. Resolve the tracked change so its text is plain. When SuperDoc lists a
  //    replacement as an insert and a delete, resolve the struck half too.
  //    `decide` reports "produced no change" as a receipt, not a throw.
  try {
    const receipt = doc.trackChanges.decide({
      decision: isDeletion ? "reject" : "accept",
      target: { id: redlineId },
    });
    if (decisionFailed(receipt)) {
      return { ok: false, reason: "resolve-failed", detail: JSON.stringify(receipt) };
    }
    if (!isDeletion && matched.pairedWithChangeId) {
      doc.trackChanges.decide({
        decision: "accept",
        target: { id: matched.pairedWithChangeId },
      });
    }
  } catch (error) {
    return { ok: false, reason: "resolve-failed", detail: String(error) };
  }

  // The approved text is the suggestion itself: resolving it was the whole job.
  if (replacement === searchText) return { ok: true };

  // 3. Replace the now-plain text with the approved text. Re-resolve the target:
  //    positions moved when the change was resolved.
  let before = new Set<string>();
  try {
    before = new Set((doc.trackChanges.list({ in: "all" }).items ?? []).map((it) => it.id));
  } catch {
    /* keep empty */
  }
  const target = findTarget(doc, searchText);
  let replaceError: string | undefined;
  if (target) {
    try {
      doc.replace({ target, text: replacement }, { changeMode: "direct" });
      acceptNewChanges(doc, before);
      return { ok: true };
    } catch (error) {
      replaceError = String(error);
    }
  }
  // The document API could not place the swap (QA run 2: `replace` threw on the
  // live CM editor right after the accept). Make it at the editor-state level.
  let viaState = false;
  try {
    viaState = editor !== null && replaceViaState(editor, searchText, replacement, anchor);
  } catch (error) {
    replaceError = `${replaceError ?? ""} | state: ${String(error)}`;
  }
  console.info("[redlines] apply", {
    id: redlineId,
    outcome: viaState ? "applied-via-state" : "replace-failed",
    replaceError: replaceError ?? (target ? undefined : "no target after resolve"),
  });
  if (!viaState) {
    return target
      ? { ok: false, reason: "replace-failed", detail: replaceError }
      : { ok: false, reason: "no-target" };
  }
  acceptNewChanges(doc, before);
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

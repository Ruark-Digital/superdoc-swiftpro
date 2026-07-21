/**
 * Selection-anchored comments bridge.
 *
 * The host panel is the only comment UI; SuperDoc comments are used purely as
 * document anchors (visible highlight + navigateTo target). Same defensive
 * contract as redlines.ts: a missing editor/instance or a SuperDoc API throw
 * is a no-op/null, never a crash.
 *
 * SuperDoc API used (from the installed v1.38 type declarations):
 *   - `editor.doc.selection.current({includeText})` → { empty, target, text }
 *   - `editor.doc.comments.create({ text, target })` → receipt with `id`
 *   - `superdoc.navigateTo({kind:'entity',entityType:'comment',entityId})`
 */

import type { Editor, SuperDoc } from "@harbour-enterprises/superdoc";

const EXCERPT_MAX = 80;

/** The slice of `editor.doc` this module reads. Kept structural (like
 *  redlines.ts's DocApiLike) so SuperDoc minor bumps don't break typecheck. */
interface CommentsDocApi {
  selection?: {
    current: (input?: { includeText?: boolean }) => {
      empty: boolean;
      target: unknown;
      text?: string;
    };
  };
  comments?: {
    create: (input: { text: string; target?: unknown }) => unknown;
  };
}

function getDoc(editor: Editor | null): CommentsDocApi | null {
  if (!editor) return null;
  try {
    // `editor.doc` is a lazily-created getter; reading it can throw if the
    // editor session is torn down.
    const doc = (editor as unknown as { doc?: unknown }).doc;
    return (doc as CommentsDocApi) ?? null;
  } catch {
    return null;
  }
}

export interface CapturedSelection {
  /** Opaque TextTarget passed straight back into `comments.create`. */
  target: unknown;
  /** Quoted selection text, trimmed and capped, for the host's chip UI. */
  excerpt: string;
}

/** Read the current selection; null when empty/non-text/unavailable. */
export function captureSelection(editor: Editor | null): CapturedSelection | null {
  const doc = getDoc(editor);
  if (!doc?.selection) return null;
  try {
    const sel = doc.selection.current({ includeText: true });
    if (!sel || sel.empty || sel.target == null) return null;
    const excerpt =
      typeof sel.text === "string" ? sel.text.trim().slice(0, EXCERPT_MAX) : "";
    return { target: sel.target, excerpt };
  } catch {
    return null;
  }
}

/** Create a SuperDoc comment anchored at `target`. Returns the new comment id
 *  or null on any failure (caller reports null to the host — the comment is
 *  saved unanchored there). */
export function createAnchoredComment(
  editor: Editor | null,
  text: string,
  target: unknown,
): string | null {
  const doc = getDoc(editor);
  if (!doc?.comments || typeof text !== "string" || text.length === 0 || target == null) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[anchored-comment] precondition failed", {
        hasCommentsApi: Boolean(doc?.comments),
        hasText: typeof text === "string" && text.length > 0,
        hasTarget: target != null,
      });
    }
    return null;
  }
  try {
    const receipt = doc.comments.create({ text, target });
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[anchored-comment] create receipt", receipt);
    }
    const id =
      receipt && typeof receipt === "object"
        ? (receipt as { id?: unknown }).id
        : null;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch (error) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[anchored-comment] create threw", error);
    }
    return null;
  }
}

/** Scroll to / activate a comment anchor. Non-critical: no-op on failure. */
export function focusComment(superdoc: SuperDoc | null, commentId: string): void {
  if (!superdoc || typeof superdoc.navigateTo !== "function") return;
  if (typeof commentId !== "string" || commentId.length === 0) return;
  try {
    void superdoc.navigateTo({
      kind: "entity",
      entityType: "comment",
      entityId: commentId,
    });
  } catch {
    // Navigation is non-critical; swallow.
  }
}

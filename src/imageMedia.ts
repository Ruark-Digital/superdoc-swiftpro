// Keeps embedded docx images visible after a collaborative JOIN.
//
// SuperDoc does NOT store image bytes in the document. An image node's `src` is
// only a media-path KEY (e.g. `word/media/image1.png`); the bytes live in a
// separate runtime map, `editor.storage.image.media`, and the image extension
// resolves the key to a data URI at render time (`storage.media[src] ?? src`).
//
// How that map is populated (super-editor `Editor.#initMedia`):
//   • document-only (no ydoc): map = the parsed docx media — always correct.
//   • collab + new room (seed): copy docx media INTO the Yjs "media" map.
//   • collab + existing room (JOIN): map = whatever is in the Yjs "media" map,
//     read ONCE, synchronously, NON-reactively, at editor init.
//
// The document text binds reactively (always shows up); the media map does not.
// So on a join/reload, if the Yjs "media" map isn't fully synced/persisted the
// instant the editor inits, every key resolves to nothing, each <img> falls back
// to the raw path, and the browser 404s it → the broken-image glyph. Because the
// node is a plain renderDOM node (no NodeView), late-arriving media never repaints.
//
// We always have the authoritative bytes locally: the host ships the full .docx on
// every init and SuperDoc parses it into `editor.options.mediaFiles` even on a join.
// So we back-fill the runtime map from that local copy (exactly what the
// document-only path does) and repaint the already-broken <img> elements. No
// dependence on the fragile Yjs media sync.

/** The slice of an <img> we touch (kept minimal so it's testable without a DOM). */
export interface ImageElementLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** The slice of a SuperDoc Editor we read (vendor internals — intentionally loose). */
export interface MediaEditorLike {
  options?: { mediaFiles?: Record<string, unknown> | null } | null;
  storage?: { image?: { media?: Record<string, string> } } | null;
  view?: { dom?: { querySelectorAll(selector: string): Iterable<ImageElementLike> } } | null;
}

/**
 * Copy every locally-parsed media entry that the store is missing. Existing
 * entries win (a collaborator's live edits stay authoritative). Returns the
 * number of keys added — purely informational.
 */
export function mergeLocalMedia(
  local: Record<string, unknown> | null | undefined,
  store: Record<string, string>,
): number {
  if (!local) return 0;
  let filled = 0;
  for (const [key, value] of Object.entries(local)) {
    if (typeof value === "string" && value.length > 0 && !store[key]) {
      store[key] = value;
      filled += 1;
    }
  }
  return filled;
}

/**
 * Map a rendered <img> src back to its data URI. The src is either the raw media
 * key (`word/media/imageN.png`) or that key resolved against the editor origin
 * (`https://editor…/word/media/imageN.png`). Already-resolved `data:` srcs and
 * non-matches return null. Matching on the full key (filename included) avoids a
 * short key falsely matching a longer filename (image1 vs image109).
 */
export function resolveMediaForSrc(
  src: string,
  media: Record<string, string>,
): string | null {
  if (!src || src.startsWith("data:")) return null;
  const exact = media[src];
  if (exact) return exact;
  for (const [key, value] of Object.entries(media)) {
    if (value && (src === key || src.endsWith(`/${key}`) || src.endsWith(key))) {
      return value;
    }
  }
  return null;
}

/**
 * Rewrite the src of any <img> still pointing at an unresolved media key. Cheap
 * and idempotent: a fully-resolved document (every src already a data URI) is a
 * no-op. Returns the number repainted.
 */
export function repaintBrokenImages(
  images: Iterable<ImageElementLike>,
  media: Record<string, string>,
): number {
  let repainted = 0;
  for (const img of images) {
    const src = img.getAttribute("src") ?? "";
    const resolved = resolveMediaForSrc(src, media);
    if (resolved && resolved !== src) {
      img.setAttribute("src", resolved);
      repainted += 1;
    }
  }
  return repainted;
}

/**
 * Ensure every embedded image resolves: back-fill the runtime media map from the
 * locally-parsed docx, then repaint any already-broken <img>. Safe to call on
 * any path — it only changes things on a join where the Yjs media map fell short.
 */
export function hydrateImageMedia(editor: MediaEditorLike | null | undefined): void {
  const image = editor?.storage?.image;
  if (!image) return;
  const media = (image.media ??= {});
  mergeLocalMedia(editor?.options?.mediaFiles, media);
  const dom = editor?.view?.dom;
  if (dom) repaintBrokenImages(dom.querySelectorAll("img"), media);
}

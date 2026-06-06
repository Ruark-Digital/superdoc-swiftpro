import type { Editor, SuperDoc } from "@harbour-enterprises/superdoc";
import type { SuperdocInit } from "./bridge";
import type { CollabHandle } from "./collabProvider";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Lifecycle callbacks main.ts wires into SuperDoc (kept here so the options
 *  builder stays pure and unit-testable without a DOM or SuperDoc instance). */
export interface SuperdocHandlers {
  /** Fires when SuperDoc is ready; the payload carries the live instance so
   *  main.ts can reach `superdoc.activeEditor` and `superdoc.navigateTo`. */
  onReady: (event: { superdoc: SuperDoc }) => void;
  /** Fires once the underlying editor is created; the cleanest hook for
   *  capturing the {@link Editor} (used to extract/apply tracked changes and
   *  to subscribe to the tracked-changes / selection events). */
  onEditorCreate?: (event: { editor: Editor }) => void;
  onPaginationUpdate: (event: { totalPages: number }) => void;
  onEditorUpdate: () => void;
  onException: (event: { error: unknown }) => void;
  onContentError: (event: { error: unknown }) => void;
}

/**
 * Build the SuperDoc constructor options for an init payload.
 *
 * When `collab` is provided it is an **already-synced** Yjs handle (see
 * connectWithTimeout) — only then do we attach `modules.collaboration`, so
 * SuperDoc's `onReady` (which gates on collab sync) fires immediately. When
 * `collab` is `null`/absent we render **document-only** from the transferred
 * bytes (graceful fallback for an unreachable server).
 */
export function buildSuperdocOptions(
  payload: SuperdocInit["payload"],
  handlers: SuperdocHandlers,
  collab?: CollabHandle | null,
) {
  return {
    selector: "#editor",
    toolbar: "#superdoc-toolbar",
    document: new Blob([payload.docBytes], { type: DOCX_MIME }),
    documentMode: payload.documentMode,
    user: payload.user,
    ...(collab ? { modules: { collaboration: { ydoc: collab.doc, provider: collab.provider } } } : {}),
    ...handlers,
  };
}

import type { Editor, SuperDoc } from "@harbour-enterprises/superdoc";
import type { SuperdocInit } from "./bridge";

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
 * IMPORTANT — there is intentionally **no `modules.collaboration`**. SuperDoc
 * gates `onReady` on the collaboration provider syncing (its internal
 * `CollaborationReady` step), so attaching a provider to an unreachable
 * WebSocket server hangs the editor forever — the document never renders. For
 * the MVP we therefore render **document-only** (local editing) from the bytes
 * the host transferred.
 *
 * `payload.roomId` / `payload.wsUrl` are still received (the bridge contract is
 * unchanged) and reserved for re-enabling collaboration once the backend collab
 * server is confirmed reachable — and then via a *connect-or-fallback* so a
 * down server still renders. See BUILD-PLAN.md.
 */
export function buildSuperdocOptions(
  payload: SuperdocInit["payload"],
  handlers: SuperdocHandlers,
) {
  return {
    selector: "#editor",
    toolbar: "#superdoc-toolbar",
    document: new Blob([payload.docBytes], { type: DOCX_MIME }),
    documentMode: payload.documentMode,
    user: payload.user,
    ...handlers,
  };
}

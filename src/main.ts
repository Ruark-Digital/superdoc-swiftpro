import { SuperDoc, type Editor } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import {
  buildRedlineClicked,
  buildRedlines,
  parseHostCommand,
  parseHostMessage,
  postToHost,
  type SuperdocInit,
} from "./bridge";
import {
  activeRedlineId,
  applyRedline,
  extractRedlines,
  focusRedline,
} from "./redlines";
import { buildSuperdocOptions } from "./superdocOptions";
import { connectWithTimeout } from "./collabProvider";
import { resolveHostOrigin } from "./env";
import "./style.css";

const HOST_ORIGIN = resolveHostOrigin(import.meta.env);
const DOC_EDIT_DEBOUNCE_MS = 1000;
/** Max wait for the collab server to sync before falling back to document-only. */
const COLLAB_SYNC_TIMEOUT_MS = 9000;

/** Guards against a second `superdoc:init` re-initializing an already-mounted editor. */
let initialized = false;
/** Latest page count from pagination layout passes; folded into `editor-ready`. */
let latestPageCount: number | undefined;
/** Pending debounce handle for the `doc-edit` ping. */
let docEditTimer: ReturnType<typeof setTimeout> | undefined;
/** Live SuperDoc instance, captured on ready (used for `navigateTo`/focus). */
let superdocInstance: SuperDoc | null = null;
/** Live editor instance, captured on create (drives tracked-change extraction). */
let editorInstance: Editor | null = null;
/** Last tracked-change id we reported as clicked — dedupes selectionUpdate noise. */
let lastClickedRedlineId: string | null = null;

function reportError(message: string): void {
  postToHost({ type: "superdoc:error", payload: { message } }, HOST_ORIGIN);
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

/**
 * Coalesce bursts of editor updates into a single `doc-edit` ping ~1s after the
 * last keystroke. The host only uses this as a version-timeline heartbeat, so a
 * debounced ping is plenty and avoids flooding the bridge.
 */
function pingDocEdit(): void {
  if (docEditTimer !== undefined) clearTimeout(docEditTimer);
  docEditTimer = setTimeout(() => {
    postToHost({ type: "superdoc:doc-edit" }, HOST_ORIGIN);
  }, DOC_EDIT_DEBOUNCE_MS);
}

/** Re-extract the document's tracked changes and push the full set to the host. */
function pushRedlines(): void {
  postToHost(buildRedlines(extractRedlines(editorInstance)), HOST_ORIGIN);
}

/**
 * Subscribe to the editor's tracked-change and selection signals once the
 * editor exists:
 *  - `tracked-changes-changed` → re-push the redline set to the host.
 *  - `selectionUpdate` → if the caret moved into a tracked change, tell the
 *    host which one was "clicked" (deduped so a single click fires once).
 */
function wireEditorEvents(editor: Editor): void {
  editor.on("tracked-changes-changed", () => {
    pushRedlines();
  });

  editor.on("selectionUpdate", () => {
    const id = activeRedlineId(editorInstance);
    if (id === lastClickedRedlineId) return;
    lastClickedRedlineId = id;
    if (id) postToHost(buildRedlineClicked(id), HOST_ORIGIN);
  });
}

async function handleInit(init: SuperdocInit): Promise<void> {
  // The host should only init once; ignore duplicates rather than double-mount.
  if (initialized) return;
  initialized = true;

  try {
    // Connect-or-fallback: sync a provider first (or null if unreachable).
    const collab = await connectWithTimeout({
      wsUrl: init.payload.wsUrl,
      roomId: init.payload.roomId,
      token: init.payload.token,
      timeoutMs: COLLAB_SYNC_TIMEOUT_MS,
    });

    // Seed vs join (see CollabHandle.isNewRoom):
    //  • Empty room  → render document-only from the bytes, then SEED the room
    //    via `upgradeToCollaboration` in onReady (below). Construction-time
    //    collaboration would just JOIN the empty room and render nothing.
    //  • Populated room → attach collaboration now to JOIN the shared state.
    //  • No sync → document-only fallback.
    const joinExisting = collab !== null && !collab.isNewRoom;

    new SuperDoc(
      buildSuperdocOptions(init.payload, {
        onPaginationUpdate: ({ totalPages }) => {
          latestPageCount = totalPages;
        },
        onEditorCreate: ({ editor }) => {
          // Capture the editor as soon as it exists and start listening for
          // tracked-change / selection events (fires before `onReady`).
          editorInstance = editor;
          wireEditorEvents(editor);
        },
        onReady: ({ superdoc }) => {
          superdocInstance = superdoc;
          // Fallback: if `onEditorCreate` did not fire (older runtime paths),
          // grab the active editor off the ready instance.
          if (!editorInstance && superdoc.activeEditor) {
            editorInstance = superdoc.activeEditor;
            wireEditorEvents(superdoc.activeEditor);
          }

          // Clears the host's "Loading editor…" overlay. Include pageCount only
          // when we actually have a number (the host drops non-numbers).
          const payloadOut =
            typeof latestPageCount === "number" ? { pageCount: latestPageCount } : {};
          postToHost({ type: "superdoc:editor-ready", payload: payloadOut }, HOST_ORIGIN);

          // Push the initial tracked-change set now that the document is loaded.
          pushRedlines();

          // New (empty) room: now that the document is rendered, promote it into
          // collaboration — this authoritatively seeds the room from the docx we
          // just loaded and attaches the live provider in place. Runs AFTER
          // editor-ready so the document is already visible; collab attaches in
          // the background. On failure we stay document-only (don't surface an
          // error — the document is fine).
          if (collab && collab.isNewRoom) {
            void superdoc
              .upgradeToCollaboration({ ydoc: collab.doc, provider: collab.provider })
              .catch((error) => {
                if (import.meta.env.DEV) {
                  // eslint-disable-next-line no-console
                  console.warn("[collab] upgradeToCollaboration failed; staying document-only", error);
                }
              });
          }
        },
        onEditorUpdate: () => {
          pingDocEdit();
        },
        onException: ({ error }) => {
          reportError(toMessage(error));
        },
        onContentError: ({ error }) => {
          reportError(toMessage(error));
        },
      }, joinExisting ? collab : null),
    );
  } catch (err) {
    reportError(toMessage(err));
  }
}

// Inbound: only ever act on a validated init from the trusted host origin.
window.addEventListener("message", (event) => {
  const init = parseHostMessage(event, HOST_ORIGIN);
  if (init) void handleInit(init);
});

// Inbound redline commands (apply / focus). Validated + origin-checked by
// `parseHostCommand`; ignored until the editor is ready.
window.addEventListener("message", (event) => {
  const cmd = parseHostCommand(event, HOST_ORIGIN);
  if (!cmd) return;
  if (cmd.type === "superdoc:apply-redline") {
    applyRedline(editorInstance, cmd.payload.redlineId, cmd.payload.replacement);
  } else {
    // `superdoc:focus-redline` — navigateTo lives on the SuperDoc instance.
    focusRedline(superdocInstance, cmd.payload.redlineId);
  }
});

// Handshake: announce readiness so the host sends us `superdoc:init`. Posted to
// the known host origin (never "*") — we have it from env.
postToHost({ type: "superdoc:ready" }, HOST_ORIGIN);

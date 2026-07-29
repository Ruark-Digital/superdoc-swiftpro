import { SuperDoc, type Editor } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import {
  buildRedlineClicked,
  buildRedlines,
  hasCollabConfig,
  parseHostCommand,
  parseHostMessage,
  postToHost,
  type SuperdocInit,
} from "./bridge";
import {
  activeRedlineId,
  applyRedline,
  canMarkSelectedText,
  extractRedlines,
  focusRedline,
  markSelectedTextAsRedline,
} from "./redlines";
import { buildSuperdocOptions } from "./superdocOptions";
import { connectWithTimeout } from "./collabProvider";
import { pickReadyTargets, resolveHostOrigins } from "./env";
import "./style.css";

// Allowlist of host origins permitted to embed/drive this editor (one editor
// deployment may serve several host environments).
const HOST_ORIGINS = resolveHostOrigins(import.meta.env);
/** The host origin confirmed to be embedding us — captured from the first valid
 *  inbound message. All outbound messages target exactly this origin. */
let trustedHostOrigin: string | null = null;
/** Outbound target: the confirmed parent once known, else the first allowlisted
 *  origin (only the contentless `ready` is sent before the handshake completes,
 *  and that one is broadcast to every allowlisted origin). */
const hostTarget = (): string => trustedHostOrigin ?? HOST_ORIGINS[0];
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
/** Reentrancy guard: the redline mutation itself fires `selectionUpdate`. */
let isMarkingSelection = false;
/** Pending debounce handle for auto-redlining a settled selection. */
let markSelectionTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A live drag emits `selectionUpdate` on every pointer move, so marking on the
 * first tick would redline a one-character sliver and then the guard (the
 * selection now overlaps a change) blocks extending it to the full span. Waiting
 * for the selection to settle marks the whole highlight exactly once, on the
 * final range — after the user finishes selecting.
 */
const SELECTION_REDLINE_DEBOUNCE_MS = 250;

function reportError(message: string): void {
  postToHost({ type: "superdoc:error", payload: { message } }, hostTarget());
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
    postToHost({ type: "superdoc:doc-edit" }, hostTarget());
  }, DOC_EDIT_DEBOUNCE_MS);
}

/** Re-extract the document's tracked changes and push the full set to the host. */
function pushRedlines(): void {
  postToHost(buildRedlines(extractRedlines(editorInstance)), hostTarget());
}

/**
 * (Re)arm the debounce that auto-redlines the current selection once it stops
 * changing. Re-reads the live selection when it fires, so it always acts on the
 * final settled range regardless of how the timer was scheduled.
 */
function scheduleRedlineForSettledSelection(): void {
  if (markSelectionTimer !== undefined) clearTimeout(markSelectionTimer);
  markSelectionTimer = setTimeout(() => {
    markSelectionTimer = undefined;
    if (isMarkingSelection || !canMarkSelectedText(editorInstance)) return;
    isMarkingSelection = true;
    try {
      if (markSelectedTextAsRedline(editorInstance)) pushRedlines();
    } finally {
      isMarkingSelection = false;
    }
  }, SELECTION_REDLINE_DEBOUNCE_MS);
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
    // A selected text range is the user's redline target. Turn it into a tracked
    // change (once the selection settles) so SuperDoc's native Accept/Reject
    // controls and the host's AI Redline panel operate on the same change. The
    // `selectionUpdate` the mark itself emits is ignored via `isMarkingSelection`.
    if (!isMarkingSelection) scheduleRedlineForSettledSelection();
    const id = activeRedlineId(editorInstance);
    if (id === lastClickedRedlineId) return;
    lastClickedRedlineId = id;
    if (id) postToHost(buildRedlineClicked(id), hostTarget());
  });
}

async function handleInit(init: SuperdocInit): Promise<void> {
  // The host should only init once; ignore duplicates rather than double-mount.
  if (initialized) return;
  initialized = true;

  try {
    // Connect-or-fallback: sync a provider first (or null if unreachable).
    // Skip it entirely for a read-only preview, which carries no socket or
    // token — otherwise we'd burn the full COLLAB_SYNC_TIMEOUT_MS waiting on a
    // connection that was never going to be attempted.
    const collab = hasCollabConfig(init.payload)
      ? await connectWithTimeout({
          wsUrl: init.payload.wsUrl,
          roomId: init.payload.roomId,
          token: init.payload.token,
          timeoutMs: COLLAB_SYNC_TIMEOUT_MS,
        })
      : null;

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
          postToHost({ type: "superdoc:editor-ready", payload: payloadOut }, hostTarget());

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
  const init = parseHostMessage(event, HOST_ORIGINS);
  if (init) {
    // Lock onto the origin that actually framed us; reply only to it from here.
    trustedHostOrigin = event.origin;
    void handleInit(init);
  }
});

// Inbound redline commands (apply / focus). Validated + origin-checked by
// `parseHostCommand`; ignored until the editor is ready.
window.addEventListener("message", (event) => {
  const cmd = parseHostCommand(event, HOST_ORIGINS);
  if (!cmd) return;
  if (cmd.type === "superdoc:apply-redline") {
    applyRedline(editorInstance, cmd.payload.redlineId, cmd.payload.replacement);
  } else {
    // `superdoc:focus-redline` — navigateTo lives on the SuperDoc instance.
    focusRedline(superdocInstance, cmd.payload.redlineId);
  }
});

// Handshake: announce readiness so the host sends us `superdoc:init`. Target the
// actual embedding parent (from referrer) when we can — exactly one origin, no
// cross-origin postMessage warnings — else broadcast to the whole allowlist (the
// browser delivers only to the matching parent, drops the rest). Never "*". Once
// the host replies with `superdoc:init`, we lock onto its origin for all messages.
pickReadyTargets(document.referrer, HOST_ORIGINS).forEach((origin) =>
  postToHost({ type: "superdoc:ready" }, origin),
);

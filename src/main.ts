import { SuperDoc, type Editor } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import {
  buildCommentCreated,
  buildRedlineClicked,
  buildRedlines,
  buildSelectionState,
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
import {
  captureSelection,
  createAnchoredComment,
  focusComment,
  type CapturedSelection,
} from "./comments";
import { buildSuperdocOptions } from "./superdocOptions";
import { hydrateImageMedia, type MediaEditorLike } from "./imageMedia";
import { connectWithTimeout } from "./collabProvider";
import { observePresence, type AwarenessLike } from "./presence";
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
/** Last non-empty text selection — the anchor target for `add-comment`. */
let lastSelection: CapturedSelection | null = null;
/** Debounce handle + last posted signal for the selection relay. */
let selectionTimer: ReturnType<typeof setTimeout> | undefined;
let lastSelectionSignal = "";
const SELECTION_DEBOUNCE_MS = 250;
/** Unsubscribe for the awareness→host presence relay (set once collab connects). */
let stopPresence: (() => void) | null = null;

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
 * Debounced relay of selection state to the host (drives the "anchored to"
 * chip). Captures at post time so a burst of selectionUpdate events costs one
 * read; dedupes so collapsed-caret churn doesn't spam the bridge.
 */
function scheduleSelectionPost(): void {
  if (selectionTimer !== undefined) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const captured = captureSelection(editorInstance);
    lastSelection = captured;
    const signal = captured ? `1:${captured.excerpt}` : "0";
    if (signal === lastSelectionSignal) return;
    lastSelectionSignal = signal;
    postToHost(
      buildSelectionState(Boolean(captured), captured?.excerpt ?? ""),
      hostTarget(),
    );
  }, SELECTION_DEBOUNCE_MS);
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
    scheduleSelectionPost();
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
          // Back-fill image bytes from the local docx before first paint so a
          // join (whose Yjs "media" map may be empty/unsynced) still resolves
          // embedded images instead of 404-ing on the raw media path.
          hydrateImageMedia(editor as unknown as MediaEditorLike);
        },
        onReady: ({ superdoc }) => {
          superdocInstance = superdoc;
          // Fallback: if `onEditorCreate` did not fire (older runtime paths),
          // grab the active editor off the ready instance.
          if (!editorInstance && superdoc.activeEditor) {
            editorInstance = superdoc.activeEditor;
            wireEditorEvents(superdoc.activeEditor);
          }

          // Safety net for the timing where the editor painted images before
          // `onEditorCreate` ran: repaint any that fell back to the raw media
          // path. Idempotent — a fully-resolved document is a no-op.
          hydrateImageMedia(editorInstance as unknown as MediaEditorLike);

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

    // Relay room presence (Yjs awareness) to the host so it can render the
    // avatar stack. Awareness lives on the provider from creation, so this
    // works for both the JOIN (construction-time) and SEED
    // (upgradeToCollaboration) paths. No collab → document-only → no presence.
    if (collab) {
      const awareness = collab.provider.awareness as unknown as AwarenessLike & {
        getLocalState(): Record<string, unknown> | null;
        setLocalStateField(field: string, value: unknown): void;
      };
      // Advertise our identity so peers can render our avatar. Merge into any
      // existing `user` (don't clobber a cursor color SuperDoc may have set).
      try {
        const existingUser = (awareness.getLocalState()?.user ?? {}) as Record<
          string,
          unknown
        >;
        awareness.setLocalStateField("user", {
          ...existingUser,
          name: init.payload.user.name,
        });
      } catch {
        // Non-fatal: if awareness isn't writable we still relay what SuperDoc set.
      }
      stopPresence?.();
      stopPresence = observePresence(awareness, hostTarget());
    }
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
  switch (cmd.type) {
    case "superdoc:apply-redline":
      applyRedline(editorInstance, cmd.payload.redlineId, cmd.payload.replacement);
      break;
    case "superdoc:focus-redline":
      // navigateTo lives on the SuperDoc instance.
      focusRedline(superdocInstance, cmd.payload.redlineId);
      break;
    case "superdoc:add-comment": {
      // Anchor at the last captured selection; null commentId tells the host
      // to save the comment unanchored (graceful degradation).
      const commentId = lastSelection
        ? createAnchoredComment(editorInstance, cmd.payload.text, lastSelection.target)
        : null;
      postToHost(buildCommentCreated(cmd.payload.requestId, commentId), hostTarget());
      break;
    }
    case "superdoc:focus-comment":
      focusComment(superdocInstance, cmd.payload.commentId);
      break;
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

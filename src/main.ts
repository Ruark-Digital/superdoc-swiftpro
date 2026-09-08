import { SuperDoc, type Editor } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import {
  buildCommentCreated,
  buildRedlineClicked,
  buildRedlines,
  buildSelectionState,
  hasCollabConfig,
  parseHostCommand,
  parseHostMessage,
  postToHost,
  type DocumentMode,
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
import { installFindBar, type SearchEditor } from "./search";
import { buildSuperdocOptions, type RedlineToolbarButton } from "./superdocOptions";
import { hydrateImageMedia, type MediaEditorLike } from "./imageMedia";
import { connectWithTimeout } from "./collabProvider";
import { observePresence, type AwarenessLike } from "./presence";
import { pickReadyTargets, resolveHostOrigins } from "./env";
import { diag, describeOrigin } from "./diag";
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
 * Switch the live document mode after load. SuperDoc gates editability (and the
 * tracked-change toolbar buttons) on this mode; construction only sets it once,
 * so a turn-based host that flips "viewing" → "suggesting" must reach us here.
 * No-ops until the SuperDoc instance is ready.
 */
function setDocumentMode(mode: DocumentMode): void {
  superdocInstance?.setDocumentMode(mode);
}

/** The editor currently driving the toolbar (falls back to the captured one). */
function currentEditor(): Editor | null {
  return superdocInstance?.activeEditor ?? editorInstance;
}

/** Placeholder dropped in by the Insert button; the user types over it. */
const INSERT_PLACEHOLDER = "[insert text]";

/**
 * Redline toolbar actions. In "suggesting" mode SuperDoc records every edit as a
 * tracked change, so these turn the current selection into a redline:
 *  - delete → strike the highlighted text (tracked deletion).
 *  - insert → drop an editable placeholder (tracked insertion) at the selection
 *    and select it, so the user can immediately type their replacement. We can't
 *    open a prompt() — the host iframe's sandbox has no `allow-modals`, so a
 *    prompt is silently blocked — hence the inline placeholder.
 * SuperDoc focuses the active editor before running a toolbar command, so acting
 * on the live selection here is safe.
 */
function redlineDeleteSelection(): void {
  const editor = currentEditor() as unknown as {
    commands?: { deleteSelection?: () => boolean };
  } | null;
  editor?.commands?.deleteSelection?.();
}

function redlineInsertAtSelection(): void {
  const editor = currentEditor() as unknown as {
    state?: { selection?: { from?: number } };
    commands?: {
      focus?: () => boolean;
      insertContent?: (value: string) => boolean;
      setTextSelection?: (range: { from: number; to: number }) => boolean;
    };
  } | null;
  if (!editor?.commands?.insertContent) return;
  // Start of the (possibly empty) selection — where the inserted content lands.
  const from = editor.state?.selection?.from ?? 0;
  editor.commands.focus?.();
  editor.commands.insertContent(INSERT_PLACEHOLDER);
  // Select the placeholder so typing replaces it in one go.
  editor.commands.setTextSelection?.({ from, to: from + INSERT_PLACEHOLDER.length });
}

// Inline-SVG icons for the custom toolbar buttons (SuperDoc renders the raw SVG
// string, matching its built-in icons). Kept minimal and theme-neutral.
const INSERT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path d="M256 80c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 144L48 224c-17.7 0-32 14.3-32 32s14.3 32 32 32l144 0 0 144c0 17.7 14.3 32 32 32s32-14.3 32-32l0-144 144 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-144 0 0-144z"/></svg>';
const DELETE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M108.5 96C129.9 68.9 168 32 256 32c88 0 126.1 36.9 147.5 64l4.5 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L104 160c-17.7 0-32-14.3-32-32s14.3-32 32-32l4.5 0zM256 256l128 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-128 0-128 0c-17.7 0-32-14.3-32-32s14.3-32 32-32l128 0z"/></svg>';

/** The Insert / Delete redline buttons injected into the SuperDoc toolbar. */
const redlineToolbarButtons: RedlineToolbarButton[] = [
  {
    type: "button",
    name: "redlineInsert",
    icon: INSERT_ICON,
    tooltip: "Insert (tracked change)",
    group: "center",
    command: redlineInsertAtSelection,
    attributes: { ariaLabel: "Insert as tracked change" },
  },
  {
    type: "button",
    name: "redlineDelete",
    icon: DELETE_ICON,
    tooltip: "Delete (tracked change)",
    group: "center",
    command: redlineDeleteSelection,
    attributes: { ariaLabel: "Delete selection as tracked change" },
  },
];

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
    // Skip it entirely for a read-only preview, which carries no socket or
    // token — otherwise we'd burn the full COLLAB_SYNC_TIMEOUT_MS waiting on a
    // connection that was never going to be attempted.
    const collab = hasCollabConfig(init.payload)
      ? await connectWithTimeout({
          wsUrl: init.payload.wsUrl,
          roomId: init.payload.roomId,
          token: init.payload.token,
          timeoutMs: COLLAB_SYNC_TIMEOUT_MS,
          // Decode the backend's custom collab messages. An `error` frame is the
          // server telling us it rejected something (e.g. an oversized seed)
          // without closing the socket — surface it so it stops being silent.
          // `connected-clients` and `my-info` are diagnostics for now; presence
          // still flows from Yjs awareness (below).
          handlers: {
            onError: (message) => {
              diag("collab.serverError", { roomId: init.payload.roomId, message });
              reportError(message);
            },
            onConnectedClients: ({ count, names }) =>
              diag("collab.connectedClients", { roomId: init.payload.roomId, count, names }),
            onMyInfo: (name) =>
              diag("collab.myInfo", { roomId: init.payload.roomId, name }),
          },
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
      buildSuperdocOptions(
        init.payload,
        {
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
        },
        joinExisting ? collab : null,
        redlineToolbarButtons,
      ),
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

      // DIAGNOSTIC (live-collab bug): watch the two channels that carry live
      // collaboration between peers.
      try {
        // 1) Awareness churn. Rapid added/removed cycles are the avatar flicker;
        //    a peer present in the state map but with no `user.name` is why it
        //    drops out of the relayed presence list (and shows no cursor).
        const aw = collab.provider.awareness as unknown as {
          clientID: number;
          getStates(): Map<number, { user?: { name?: unknown } }>;
          on(
            event: "change",
            cb: (d: { added: number[]; updated: number[]; removed: number[] }) => void,
          ): void;
        };
        aw.on("change", ({ added, updated, removed }) => {
          const states = aw.getStates();
          const peers = [...states.entries()]
            .filter(([id]) => id !== aw.clientID)
            .map(([id, s]) => ({
              id,
              name: typeof s?.user?.name === "string" ? s.user.name : null,
            }));
          diag("awareness.change", {
            self: aw.clientID,
            total: states.size,
            peers,
            added,
            updated,
            removed,
          });
        });

        // 2) Doc updates. A remote-origin update proves peer edits are crossing
        //    the wire; if only local-origin updates ever appear, the peers are
        //    isolated (edits never sync, no remote cursor).
        collab.doc.on("update", (update: Uint8Array, origin: unknown) => {
          diag("doc.update", {
            origin: describeOrigin(origin),
            bytes: update.byteLength,
            local: origin === null || origin === undefined,
          });
        });
      } catch {
        // Diagnostics must never break collaboration.
      }
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
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log("[anchored-comment] add-comment handled", {
          requestId: cmd.payload.requestId,
          hadSelection: Boolean(lastSelection),
          commentId,
        });
      }
      postToHost(buildCommentCreated(cmd.payload.requestId, commentId), hostTarget());
      break;
    }
    case "superdoc:focus-comment":
      focusComment(superdocInstance, cmd.payload.commentId);
      break;
    case "superdoc:set-mode":
      // Turn-based redline negotiation: the host flips the live edit permission
      // after load (e.g. "viewing" → "suggesting" when it becomes this user's
      // turn) so the tracked-change toolbar buttons enable. Without this the
      // mode is frozen at whatever `superdoc:init` carried.
      setDocumentMode(cmd.payload.documentMode);
      break;
  }
});

// Find bar (Ctrl/Cmd-F) — QA #231. Installed once; the getter reads the live
// editor so search works as soon as the document is ready.
installFindBar(() => editorInstance as unknown as SearchEditor | null);

// Handshake: announce readiness so the host sends us `superdoc:init`. Target the
// actual embedding parent (from referrer) when we can — exactly one origin, no
// cross-origin postMessage warnings — else broadcast to the whole allowlist (the
// browser delivers only to the matching parent, drops the rest). Never "*". Once
// the host replies with `superdoc:init`, we lock onto its origin for all messages.
pickReadyTargets(document.referrer, HOST_ORIGINS).forEach((origin) =>
  postToHost({ type: "superdoc:ready" }, origin),
);

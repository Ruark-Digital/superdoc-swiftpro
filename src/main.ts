import { SuperDoc } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { parseHostMessage, postToHost, type SuperdocInit } from "./bridge";
import "./style.css";

const HOST_ORIGIN = import.meta.env.VITE_HOST_ORIGIN;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_EDIT_DEBOUNCE_MS = 1000;

/** Guards against a second `superdoc:init` re-initializing an already-mounted editor. */
let initialized = false;
/** Latest page count from pagination layout passes; folded into `editor-ready`. */
let latestPageCount: number | undefined;
/** Pending debounce handle for the `doc-edit` ping. */
let docEditTimer: ReturnType<typeof setTimeout> | undefined;

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

function handleInit(init: SuperdocInit): void {
  // The host should only init once; ignore duplicates rather than double-mount.
  if (initialized) return;
  initialized = true;

  const { payload } = init;

  try {
    // The host already fetched the .docx and transferred the bytes, so we build
    // the document Blob locally — no network/auth/CORS needed on this side.
    const blob = new Blob([payload.docBytes], { type: DOCX_MIME });

    // Yjs collaboration against the SAME server SwiftPro uses. roomId is already
    // namespaced (`…:superdoc`) by the host — passed through verbatim.
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(payload.wsUrl, payload.roomId, ydoc);
    provider.on("connection-error", () => {
      reportError("Collaboration server connection error");
    });

    new SuperDoc({
      selector: "#editor",
      document: blob,
      documentMode: payload.documentMode,
      user: payload.user,
      // Provider-agnostic collaboration: SuperDoc drives any provider exposing
      // awareness + on/off + synced, which y-websocket's WebsocketProvider does.
      modules: {
        collaboration: { ydoc, provider },
      },
      onPaginationUpdate: ({ totalPages }) => {
        latestPageCount = totalPages;
      },
      onReady: () => {
        // Clears the host's "Loading editor…" overlay. Include pageCount only
        // when we actually have a number (the host drops non-numbers).
        const payloadOut =
          typeof latestPageCount === "number" ? { pageCount: latestPageCount } : {};
        postToHost({ type: "superdoc:editor-ready", payload: payloadOut }, HOST_ORIGIN);
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
    });
  } catch (err) {
    reportError(toMessage(err));
  }
}

// Inbound: only ever act on a validated init from the trusted host origin.
window.addEventListener("message", (event) => {
  const init = parseHostMessage(event, HOST_ORIGIN);
  if (init) handleInit(init);
});

// Handshake: announce readiness so the host sends us `superdoc:init`. Posted to
// the known host origin (never "*") — we have it from env.
postToHost({ type: "superdoc:ready" }, HOST_ORIGIN);

import { SuperDoc } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import { parseHostMessage, postToHost, type SuperdocInit } from "./bridge";
import { buildSuperdocOptions } from "./superdocOptions";
import "./style.css";

const HOST_ORIGIN = import.meta.env.VITE_HOST_ORIGIN;
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

  try {
    // Document-only render — no collaboration module (see superdocOptions.ts for
    // why: collab would gate rendering on an unreachable WS server). The host
    // already fetched the .docx and transferred the bytes, so no network/auth/
    // CORS is needed on this side.
    new SuperDoc(
      buildSuperdocOptions(init.payload, {
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
      }),
    );
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

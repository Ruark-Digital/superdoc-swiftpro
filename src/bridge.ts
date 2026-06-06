/**
 * postMessage bridge — the AGPL/proprietary boundary.
 *
 * This module is the *only* contract between this AGPL SuperDoc app and the
 * proprietary SwiftPro host (`swifter`). The two apps run on different origins
 * and never share code; they exchange plain `{ type, payload? }` objects via
 * `window.postMessage`. Keeping the boundary arms-length is what keeps
 * SuperDoc's AGPL copyleft out of SwiftPro's bundle.
 *
 * This file mirrors the host side: `swifter/src/pages/CollaborationToolPage/
 * collab/superdocBridge.ts`. If you change a message shape, change it there too.
 */

export type DocumentMode = "editing" | "viewing" | "suggesting";

export type RedlineKind = "insertion" | "deletion";
export interface RedlineSpan {
  redlineId: string;
  kind: RedlineKind;
  text: string;
  author?: string;
  createdAt?: string;
}

const DOCUMENT_MODES: readonly DocumentMode[] = ["editing", "viewing", "suggesting"];

/** Payload of the single inbound message the host sends us. */
export interface SuperdocInitPayload {
  /** The .docx bytes, fetched by the host and transferred to us (no auth/CORS needed here). */
  docBytes: ArrayBuffer;
  fileName: string;
  fileType: string;
  documentMode: DocumentMode;
  user: { name: string; email: string };
  /**
   * y-websocket room. ⚠️ ALREADY namespaced by the host as `<baseRoom>-superdoc`
   * — use verbatim. Do NOT append or strip the suffix.
   */
  roomId: string;
  /** WebSocket URL of the shared Yjs collab server (e.g. wss://api.swiftpro.tech/api/v1/dev/contract). */
  wsUrl: string;
  /** JWT for the WS handshake — sent via the `Sec-WebSocket-Protocol` subprotocol. */
  token: string;
}

/** The one message the host → this app. */
export interface SuperdocInit {
  type: "superdoc:init";
  payload: SuperdocInitPayload;
}

/** Messages this app → host. */
export type SuperdocOutbound =
  | { type: "superdoc:ready" }
  | { type: "superdoc:editor-ready"; payload: { pageCount?: number } }
  | { type: "superdoc:doc-edit" }
  | { type: "superdoc:error"; payload: { message: string } }
  | { type: "superdoc:redlines"; payload: { redlines: RedlineSpan[] } }
  | { type: "superdoc:redline-clicked"; payload: { redlineId: string } };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUser(value: unknown): value is { name: string; email: string } {
  return isObject(value) && typeof value.name === "string" && typeof value.email === "string";
}

/** True when `origin` is the (or one of the) configured host origin(s). One
 *  editor deployment can be embedded by several host environments, so the host
 *  origin may be an allowlist. */
function isAllowedOrigin(origin: string, hostOrigins: string | string[]): boolean {
  return Array.isArray(hostOrigins) ? hostOrigins.includes(origin) : origin === hostOrigins;
}

/**
 * Validate an inbound `message` event against the host contract.
 *
 * Returns a typed {@link SuperdocInit} only when the event is trustworthy and
 * well-formed; returns `null` otherwise (wrong origin, wrong shape, not our
 * message). Callers should ignore `null` — never throw on untrusted input.
 *
 * @param event        the raw MessageEvent from `window.addEventListener("message")`
 * @param hostOrigins  the expected origin, or an allowlist of origins (VITE_HOST_ORIGIN); anything else is dropped
 */
export function parseHostMessage(event: MessageEvent, hostOrigins: string | string[]): SuperdocInit | null {
  // Security: only ever trust messages from a configured host origin.
  if (!isAllowedOrigin(event.origin, hostOrigins)) return null;

  const data: unknown = event.data;
  if (!isObject(data) || data.type !== "superdoc:init") return null;

  const payload = data.payload;
  if (!isObject(payload)) return null;

  // docBytes MUST be a real ArrayBuffer — the host transfers it as one.
  if (!(payload.docBytes instanceof ArrayBuffer)) return null;
  if (typeof payload.fileName !== "string") return null;
  if (typeof payload.fileType !== "string") return null;
  if (typeof payload.roomId !== "string" || payload.roomId.length === 0) return null;
  if (typeof payload.wsUrl !== "string" || payload.wsUrl.length === 0) return null;
  if (typeof payload.token !== "string" || payload.token.length === 0) return null;
  if (!isUser(payload.user)) return null;

  // documentMode defaults to "editing" if absent/invalid (per the host contract).
  const documentMode = DOCUMENT_MODES.includes(payload.documentMode as DocumentMode)
    ? (payload.documentMode as DocumentMode)
    : "editing";

  return {
    type: "superdoc:init",
    payload: {
      docBytes: payload.docBytes,
      fileName: payload.fileName,
      fileType: payload.fileType,
      documentMode,
      user: payload.user,
      roomId: payload.roomId,
      wsUrl: payload.wsUrl,
      token: payload.token,
    },
  };
}

/** Commands the host sends us to act on the document. */
export type HostCommand =
  | { type: "superdoc:apply-redline"; payload: { redlineId: string; replacement: string } }
  | { type: "superdoc:focus-redline"; payload: { redlineId: string } };

export function parseHostCommand(event: MessageEvent, hostOrigins: string | string[]): HostCommand | null {
  if (!isAllowedOrigin(event.origin, hostOrigins)) return null;
  const data: unknown = event.data;
  if (!isObject(data)) return null;
  if (data.type === "superdoc:apply-redline") {
    const p = data.payload;
    if (!isObject(p) || typeof p.redlineId !== "string" || typeof p.replacement !== "string") return null;
    return { type: "superdoc:apply-redline", payload: { redlineId: p.redlineId, replacement: p.replacement } };
  }
  if (data.type === "superdoc:focus-redline") {
    const p = data.payload;
    if (!isObject(p) || typeof p.redlineId !== "string") return null;
    return { type: "superdoc:focus-redline", payload: { redlineId: p.redlineId } };
  }
  return null;
}

export function buildRedlines(redlines: RedlineSpan[]): SuperdocOutbound {
  return { type: "superdoc:redlines", payload: { redlines } };
}

export function buildRedlineClicked(redlineId: string): SuperdocOutbound {
  return { type: "superdoc:redline-clicked", payload: { redlineId } };
}

/**
 * Send a message to the host, always targeting the exact host origin (never
 * "*"). We know the host origin from env even for the very first handshake, so
 * there is no reason to broadcast.
 *
 * @param msg         the outbound message
 * @param hostOrigin  the target origin (VITE_HOST_ORIGIN)
 * @param target      the window to post to (defaults to `window.parent`; injectable for tests)
 */
export function postToHost(
  msg: SuperdocOutbound,
  hostOrigin: string,
  target: Pick<Window, "postMessage"> = window.parent,
): void {
  target.postMessage(msg, hostOrigin);
}

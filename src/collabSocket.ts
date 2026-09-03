// Mirrors swifter's useCollabProvider.makeAuthWebSocketClass so this iframe's
// Yjs provider speaks the exact same protocol as the host's collab client:
//   • URL: y-websocket builds `${wsUrl}/${room}`; the backend instead serves
//     `${base}/collab?doc=<room>`. We rewrite to that shape.
//   • Auth: JWT via the `Sec-WebSocket-Protocol` subprotocol ["access_token", token].
// If you change this, change it there too.

import { diag } from "./diag";

/** Rewrite a y-websocket-built URL to the backend's `/collab?doc=<room>` shape. */
export function rewriteCollabUrl(raw: string, docName: string): string {
  try {
    const u = new URL(raw);
    const segments = u.pathname.split("/").filter(Boolean);
    const decodeSafe = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    if (segments.length > 0 && decodeSafe(segments[segments.length - 1]) === docName) {
      segments.pop();
    }
    if (segments.length === 0 || segments[segments.length - 1] !== "collab") {
      segments.push("collab");
    }
    u.pathname = "/" + segments.join("/");
    u.searchParams.set("doc", docName);
    return u.toString();
  } catch {
    return raw;
  }
}

/** The WS subprotocols: JWT smuggled as the access_token subprotocol. */
export function collabSubprotocols(
  token: string | undefined,
  fallback: string | string[] | undefined,
): string | string[] | undefined {
  return token ? ["access_token", token] : fallback;
}

/**
 * y-protocols message type for awareness updates — the first byte of every
 * outbound Yjs frame. Mirrors y-websocket's `messageAwareness`. Doc-sync frames
 * (type 0) and everything else are never throttled.
 */
export const MESSAGE_AWARENESS = 1;
/** Coalesce awareness sends to ~30/s, matching the host's working client. */
export const AWARENESS_THROTTLE_MS = Math.floor(1000 / 30);

type WsPayload = Parameters<WebSocket["send"]>[0];

/** Byte length of an outbound WS payload (0 for shapes we can't size). */
export function payloadByteLength(data: unknown): number {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return (data as ArrayBufferView).byteLength;
  if (data instanceof Blob) return data.size;
  return 0;
}

/**
 * DIAGNOSTIC (message-too-large bug): outbound frames at/above this size are the
 * suspects for the server's 1009 "Message too large" close. The initial
 * document seed (whole doc + embedded image bytes, one Yjs sync frame) is the
 * prime candidate; logging its exact size tells us whether the fix is
 * externalising images / chunking (frame > server cap) or raising an edge limit.
 */
export const LARGE_FRAME_BYTES = 512 * 1024;

/** First byte (the y-protocols message type) of an outbound WS payload, or -1. */
export function messageType(data: unknown): number {
  if (data instanceof Uint8Array) return data.length > 0 ? data[0] : -1;
  if (data instanceof ArrayBuffer) {
    const view = new Uint8Array(data);
    return view.length > 0 ? view[0] : -1;
  }
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    const view = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return view.length > 0 ? view[0] : -1;
  }
  return -1;
}

/**
 * Wrap a raw `send` so that outbound **awareness** frames are coalesced to one
 * every {@link AWARENESS_THROTTLE_MS} (latest-wins, trailing-edge). Doc-sync and
 * all other frames pass straight through, so edit latency is unaffected. Pure
 * and dependency-injected (`isOpen`) so it is unit-testable without a WebSocket.
 *
 * This is the fix for the reconnect loop: without it, every awareness change
 * (cursor moves, plus the full-state burst y-websocket sends on each connect)
 * hits the server unthrottled, tripping SwiftPro's collab-server flood
 * protection, which closes the socket. y-websocket reconnects, re-bursts, and is
 * closed again — the endless `connected → close` loop that made presence avatars
 * flicker and stopped edits/cursors from ever syncing between peers. The host's
 * proven client (`useYooptaYjs.installAwarenessThrottle`) throttles the same way.
 */
export function makeThrottledSend(
  rawSend: (data: WsPayload) => void,
  isOpen: () => boolean,
  intervalMs: number = AWARENESS_THROTTLE_MS,
): (data: WsPayload) => void {
  let pending: WsPayload | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (data: WsPayload) => {
    if (messageType(data) !== MESSAGE_AWARENESS) {
      rawSend(data);
      return;
    }
    pending = data;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = null;
      if (next !== null && isOpen()) rawSend(next);
    }, intervalMs);
  };
}

/**
 * A WebSocket subclass that applies the URL rewrite + auth subprotocol AND
 * throttles outbound awareness frames (see {@link makeThrottledSend}). Baking
 * the throttle into the socket means every reconnect's socket is covered
 * automatically, with no per-`status` re-patch. Pass it to y-websocket as
 * `WebSocketPolyfill`.
 */
export function makeAuthWebSocketClass(
  token: string | undefined,
  docName: string,
): typeof WebSocket {
  return class CollabAuthSocket extends WebSocket {
    #throttledSend?: (data: WsPayload) => void;

    constructor(url: string | URL, protocols?: string | string[]) {
      const raw = typeof url === "string" ? url : url.toString();
      super(rewriteCollabUrl(raw, docName), collabSubprotocols(token, protocols));
    }

    send(data: WsPayload): void {
      // DIAGNOSTIC: measure large outbound frames — the seed frame that trips
      // the server's 1009 close passes through here. type 0 = sync (the seed).
      const bytes = payloadByteLength(data);
      if (bytes >= LARGE_FRAME_BYTES) {
        diag("collab.sendLarge", { type: messageType(data), bytes });
      }
      if (!this.#throttledSend) {
        this.#throttledSend = makeThrottledSend(
          (d) => WebSocket.prototype.send.call(this, d),
          () => this.readyState === WebSocket.OPEN,
        );
      }
      this.#throttledSend(data);
    }
  } as unknown as typeof WebSocket;
}

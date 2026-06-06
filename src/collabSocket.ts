// Mirrors swifter's useCollabProvider.makeAuthWebSocketClass so this iframe's
// Yjs provider speaks the exact same protocol as the host's collab client:
//   • URL: y-websocket builds `${wsUrl}/${room}`; the backend instead serves
//     `${base}/collab?doc=<room>`. We rewrite to that shape.
//   • Auth: JWT via the `Sec-WebSocket-Protocol` subprotocol ["access_token", token].
// If you change this, change it there too.

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

/** A WebSocket subclass that applies the URL rewrite + auth subprotocol. Pass it
 *  to y-websocket as `WebSocketPolyfill`. */
export function makeAuthWebSocketClass(
  token: string | undefined,
  docName: string,
): typeof WebSocket {
  return class CollabAuthSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const raw = typeof url === "string" ? url : url.toString();
      super(rewriteCollabUrl(raw, docName), collabSubprotocols(token, protocols));
    }
  } as unknown as typeof WebSocket;
}

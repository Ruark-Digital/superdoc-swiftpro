import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { makeAuthWebSocketClass } from "./collabSocket";

export interface CollabConnectConfig {
  wsUrl: string;
  roomId: string;
  token: string;
  /** Max time to wait for the first server sync before falling back. */
  timeoutMs: number;
}

/** A synced collaboration handle, ready to hand to SuperDoc's collaboration module. */
export interface CollabHandle {
  doc: Y.Doc;
  provider: WebsocketProvider;
}

/** Minimal provider shape we depend on (lets tests inject a fake). */
interface ProviderLike {
  on(event: "sync", cb: (isSynced: boolean) => void): void;
  on(event: "connection-error" | "connection-close", cb: (e: unknown) => void): void;
  destroy(): void;
}

interface Deps {
  createProvider: (wsUrl: string, room: string, doc: Y.Doc, token: string) => ProviderLike;
}

const defaultDeps: Deps = {
  createProvider: (wsUrl, room, doc, token) =>
    new WebsocketProvider(wsUrl, room, doc, {
      WebSocketPolyfill: makeAuthWebSocketClass(token, room),
    }) as unknown as ProviderLike,
};

/**
 * Connect a Yjs provider and resolve only once it has synced with the server,
 * within `timeoutMs`. On timeout or connection error, tears the provider down
 * and resolves `null` so the caller can render document-only. This is the
 * connect-or-fallback that keeps SuperDoc from hanging on an unreachable server.
 */
export function connectWithTimeout(
  config: CollabConnectConfig,
  deps: Deps = defaultDeps,
): Promise<CollabHandle | null> {
  return new Promise((resolve) => {
    const doc = new Y.Doc();
    const provider = deps.createProvider(config.wsUrl, config.roomId, doc, config.token);
    let settled = false;

    const timer = setTimeout(() => finish(false), config.timeoutMs);

    function finish(synced: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (synced) {
        resolve({ doc, provider: provider as unknown as WebsocketProvider });
      } else {
        provider.destroy();
        doc.destroy();
        resolve(null);
      }
    }

    provider.on("sync", (isSynced: boolean) => {
      if (isSynced) finish(true);
    });
    provider.on("connection-error", () => finish(false));
    provider.on("connection-close", () => finish(false));
  });
}

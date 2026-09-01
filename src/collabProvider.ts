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

/**
 * Yjs map + key we stamp once a room has been authoritatively seeded from a
 * docx. Presence of this flag — NOT merely the existence of shared types — is
 * what tells a returning client to JOIN rather than re-SEED.
 *
 * `upgradeToCollaboration` registers SuperDoc's shared types (so `doc.share`
 * becomes non-empty) before the document content has necessarily flushed to the
 * server. A client that opened a fresh room and left immediately could leave the
 * server holding those empty type structures with no content, which the old
 * `doc.share.size === 0` check misread as "already populated" → JOIN → a blank
 * page. Because Yjs updates flush in order over the single socket, this marker
 * can only have reached the server if the seed content that preceded it did too,
 * so a room whose seed was interrupted before flushing correctly reads as new
 * and is re-seeded from the docx the client still holds.
 */
export const SEED_MARKER_MAP = "__swiftpro_meta";
export const SEED_MARKER_KEY = "seeded";

/** True once {@link markRoomSeeded} has stamped this (synced) room. */
export function roomIsSeeded(doc: Y.Doc): boolean {
  return doc.getMap(SEED_MARKER_MAP).get(SEED_MARKER_KEY) === true;
}

/** Stamp the seed marker after a successful `upgradeToCollaboration` seed. */
export function markRoomSeeded(doc: Y.Doc): void {
  doc.getMap(SEED_MARKER_MAP).set(SEED_MARKER_KEY, true);
}

/** A synced collaboration handle, ready to hand to SuperDoc's collaboration module. */
export interface CollabHandle {
  doc: Y.Doc;
  provider: WebsocketProvider;
  /**
   * True when the synced room has not yet been seeded (no {@link SEED_MARKER_KEY}
   * flag) — i.e. this client should SEED the room from the document via SuperDoc
   * `upgradeToCollaboration`, then call {@link markRoomSeeded}. When false, the
   * room was already seeded and the caller should JOIN it (construction-time
   * collaboration) rather than re-seed, to avoid disturbing other users' state.
   */
  isNewRoom: boolean;
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
        // After the initial sync, the room is "new" (needs seeding) unless it
        // carries our seed marker. Testing content presence rather than
        // `doc.share.size` avoids misreading a half-flushed seed (empty shared
        // types, no content) as populated — see SEED_MARKER_MAP.
        const isNewRoom = !roomIsSeeded(doc);
        resolve({ doc, provider: provider as unknown as WebsocketProvider, isNewRoom });
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

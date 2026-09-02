import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { makeAuthWebSocketClass } from "./collabSocket";
import { diag } from "./diag";

export interface CollabConnectConfig {
  wsUrl: string;
  roomId: string;
  token: string;
  /** Max time to wait for the first server sync before falling back. */
  timeoutMs: number;
}

/**
 * SuperDoc stores the document body in a Yjs XML fragment named `"supereditor"`
 * (this is the fragment `upgradeToCollaboration` seeds and construction-time
 * collaboration hydrates from). We key seed-vs-join off whether that fragment
 * actually holds content — the only thing that decides whether a JOIN paints a
 * real document or a blank page.
 */
export const DOC_FRAGMENT = "supereditor";

/**
 * True when the synced room already holds document content, i.e. the
 * `"supereditor"` fragment has at least one child. Only then is JOINing safe;
 * an empty fragment must be (re-)seeded from the docx.
 *
 * Why not a marker / `doc.share.size`: `upgradeToCollaboration` registers
 * SuperDoc's shared types and writes a `meta` bootstrap flag as part of seeding,
 * and any of those can reach the server independently of the (larger) body
 * fragment — a seed interrupted mid-flush, or a collab server that drops room
 * state, can leave the room with those side structures present but the body
 * empty. `doc.share.size === 0` and a "seeded" flag both misread that as
 * populated → JOIN → the blank page users saw on reload. Testing the body
 * fragment directly is the signal that matches what actually renders, and it
 * self-heals: an empty body always re-seeds from the docx the client still holds.
 */
export function roomHasContent(doc: Y.Doc): boolean {
  return doc.getXmlFragment(DOC_FRAGMENT).length > 0;
}

/** A synced collaboration handle, ready to hand to SuperDoc's collaboration module. */
export interface CollabHandle {
  doc: Y.Doc;
  provider: WebsocketProvider;
  /**
   * True when the synced room's body fragment is empty — i.e. this client should
   * SEED the room from the document via SuperDoc `upgradeToCollaboration`. When
   * false, the room already holds document content and the caller should JOIN it
   * (construction-time collaboration) rather than re-seed.
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

    const timer = setTimeout(() => {
      diag("collab.sync-timeout", { roomId: config.roomId, timeoutMs: config.timeoutMs });
      finish(false);
    }, config.timeoutMs);

    function finish(synced: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (synced) {
        // After the initial sync, the room needs seeding unless its body
        // fragment already holds content. See roomHasContent for why we test the
        // fragment directly rather than `doc.share.size` or a seed marker.
        const isNewRoom = !roomHasContent(doc);
        // DIAGNOSTIC (blank-body bug): capture what the freshly-synced room
        // actually holds. `bodyFragmentLen > 0` with `isNewRoom: false` on a
        // reload that then paints blank is the "JOIN a contentful room that
        // renders nothing" signal we're hunting.
        diag("collab.synced", {
          roomId: config.roomId,
          isNewRoom,
          bodyFragmentLen: doc.getXmlFragment(DOC_FRAGMENT).length,
          shareKeys: Array.from(doc.share.keys()),
        });
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
    provider.on("connection-error", () => {
      diag("collab.connection-error", { roomId: config.roomId });
      finish(false);
    });
    provider.on("connection-close", () => {
      diag("collab.connection-close", { roomId: config.roomId });
      finish(false);
    });
  });
}

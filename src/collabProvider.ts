import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { makeAuthWebSocketClass } from "./collabSocket";
import { registerCustomMessageHandlers, type CollabMessageHandlers } from "./collabMessages";
import { diag } from "./diag";

export interface CollabConnectConfig {
  wsUrl: string;
  roomId: string;
  token: string;
  /** Max time to wait for the first server sync before falling back. */
  timeoutMs: number;
  /**
   * Handlers for the backend's custom WebSocket messages (connected-clients,
   * my-info, error). Registered on the provider as soon as it's created, so the
   * server's error/presence frames are surfaced instead of dropped.
   */
  handlers?: CollabMessageHandlers;
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
 * True when the synced room already holds *renderable* document content in the
 * `"supereditor"` body fragment. Only then is JOINing safe; anything else must
 * be (re-)seeded from the docx.
 *
 * Why not `doc.share.size` or a seed marker: `upgradeToCollaboration` registers
 * SuperDoc's shared types and writes a `meta` bootstrap flag as part of seeding,
 * and any of those can reach the server independently of the (larger) body
 * fragment. `doc.share.size === 0` and a "seeded" flag both misread that as
 * populated → JOIN → a blank page. Testing the body fragment is the signal that
 * matches what actually renders.
 *
 * Why not a bare `length > 0`: a room can hold a body fragment that is
 * non-empty yet paints nothing. The poison observed in production is a single
 * empty `paragraph` node (`length === 1`, zero text) left by a bad seed from an
 * older build. `length > 0` reads that as populated, so every client JOINs it,
 * shows a permanently blank page, and never re-seeds — the exact "blank only
 * after reload, forever" bug. So we look past the top-level count and ask
 * whether the fragment holds any real content (see {@link fragmentHasContent}).
 * An empty body — truly empty, or only empty paragraphs — reads as "needs
 * seeding" and self-heals from the docx the client still holds; a body that
 * carries text or a real element (image, table, a paragraph with children) is
 * genuine content and is JOINed, so live edits from peers are never wiped.
 */
export function roomHasContent(doc: Y.Doc): boolean {
  return fragmentHasContent(doc.getXmlFragment(DOC_FRAGMENT));
}

/** One child of an XML fragment/element as returned by Yjs `toArray()`. */
type YXmlChild = Y.XmlElement | Y.XmlText | Y.XmlHook;

/**
 * Whether an XML fragment holds any renderable content. Recurses because the
 * poison (an empty paragraph) is a top-level element that is itself non-empty as
 * a *node* but empty as *content*.
 */
export function fragmentHasContent(frag: Y.XmlFragment): boolean {
  return frag.toArray().some(nodeHasContent);
}

/**
 * Content test for a single node:
 *  - non-empty text → content;
 *  - any element that is not a `paragraph` (image, table, drawing, list, page
 *    break, …) → content, since it renders something even without text;
 *  - a `paragraph` → content only if a descendant has content (an *empty*
 *    paragraph, the observed poison, does not);
 *  - anything else (e.g. an embedded `Y.XmlHook`) → treated as content, so we
 *    never wipe a structure we don't recognise.
 */
function nodeHasContent(node: YXmlChild): boolean {
  if (node instanceof Y.XmlText) return node.length > 0;
  if (node instanceof Y.XmlElement) {
    if (node.nodeName && node.nodeName !== "paragraph") return true;
    return node.toArray().some(nodeHasContent);
  }
  return true;
}

/** A synced collaboration handle, ready to hand to SuperDoc's collaboration module. */
export interface CollabHandle {
  doc: Y.Doc;
  provider: WebsocketProvider;
  /**
   * True when the synced room's body fragment holds no renderable content —
   * empty, or only empty paragraphs (a poisoned room). This client should then
   * SEED the room from the document via SuperDoc `upgradeToCollaboration`. When
   * false, the room already holds real document content and the caller should
   * JOIN it (construction-time collaboration) rather than re-seed.
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

    // Decode the backend's custom messages (connected-clients, my-info, error)
    // instead of letting y-websocket drop them as unknown types. Registered
    // before the first frame can arrive.
    if (config.handlers) {
      registerCustomMessageHandlers(provider as unknown as { messageHandlers?: unknown }, config.handlers);
    }

    // DIAGNOSTIC (live-collab bug): long-lived connection-lifecycle trace. These
    // listeners intentionally outlive the initial-sync settle below so a
    // reconnect loop (status flapping / repeated closes after we're connected)
    // is visible — that loop clears and restores peers (avatar flicker) and
    // disrupts live updates. Attached best-effort; a fake provider in tests may
    // not emit "status", which is fine.
    let reconnects = 0;
    const traced = provider as unknown as {
      on(event: string, cb: (arg: unknown) => void): void;
    };
    try {
      traced.on("status", (s: unknown) => {
        const status = (s as { status?: string })?.status ?? s;
        if (status === "connecting" && settled) reconnects += 1;
        diag("collab.status", { roomId: config.roomId, status, reconnects });
      });
      traced.on("connection-close", (event: unknown) => {
        const e = event as { code?: number; reason?: string; wasClean?: boolean } | null;
        // The close code/reason is the definitive "why the server dropped us"
        // signal — 1000 (normal) vs 1006 (abnormal / rate-limit / proxy) vs a
        // 4xxx policy/auth code — kept so a lingering loop is diagnosable.
        diag("collab.close", {
          roomId: config.roomId,
          reconnects,
          code: e?.code ?? null,
          reason: e?.reason ?? "",
          wasClean: e?.wasClean ?? null,
        });
      });
      traced.on("connection-error", () => diag("collab.error", { roomId: config.roomId }));
    } catch {
      // Non-fatal: diagnostics must never break the connection path.
    }

    const timer = setTimeout(() => finish(false), config.timeoutMs);

    function finish(synced: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (synced) {
        // After the initial sync, the room needs seeding unless its body
        // fragment already holds content. See roomHasContent for why we test the
        // fragment directly rather than `doc.share.size` or a seed marker.
        const isNewRoom = !roomHasContent(doc);
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

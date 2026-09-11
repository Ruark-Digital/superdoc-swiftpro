/**
 * Presence bridge — relays Yjs awareness (who's in the room) to the host.
 *
 * SuperDoc's collaboration module already broadcasts each client's identity via
 * the shared provider's `awareness` (a y-protocols Awareness). The host can't
 * read that map (it lives on this origin's provider), so we map it to the
 * host's `PresenceUser[]` contract and post it on every awareness change.
 *
 * The mapping mirrors the host's own `useCollabProvider.subscribeAwareness`:
 *   - exclude the local client (we render "self" separately / not at all),
 *   - require a `user.name` (skip cursors that haven't announced identity yet),
 *   - de-dupe by `name|avatarUrl` (a user open in two tabs is one person),
 *   - exclude the local *identity*, not just the local client id: a browser
 *     refresh leaves the previous session's awareness entry in the map (a
 *     different client id, same user) until it times out, so excluding only the
 *     current client id would render that stale entry as a ghost peer of
 *     yourself.
 */

import { buildPresence, postToHost, type PresenceUser } from "./bridge";

/** Minimal Awareness surface we depend on (lets tests inject a fake). */
export interface AwarenessLike {
  /** This client's awareness id — excluded from the relayed list. */
  clientID: number;
  getStates(): Map<number, unknown>;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

/**
 * Pure mapper: awareness state map → host `PresenceUser[]` (peers only).
 * Exported for unit testing without a live provider.
 */
/** Parse an awareness state into a named identity, or null if unnamed. */
const parseIdentity = (
  state: unknown,
): { name: string; avatarUrl?: string; key: string } | null => {
  const user = (state as { user?: { name?: unknown; avatarUrl?: unknown } } | null)
    ?.user;
  const name = user && typeof user.name === "string" ? user.name : "";
  if (!name) return null;
  const avatarUrl =
    user && typeof user.avatarUrl === "string" ? user.avatarUrl : undefined;
  return { name, avatarUrl, key: `${name}|${avatarUrl ?? ""}` };
};

export function mapAwarenessToUsers(
  states: Map<number, unknown>,
  localId: number,
): PresenceUser[] {
  const users: PresenceUser[] = [];
  const seen = new Set<string>();
  // Seed the de-dupe set with our own identity so a stale entry from a previous
  // session of ours (an old client id left behind by a refresh) is skipped, not
  // just the current local client id.
  const self = parseIdentity(states.get(localId));
  if (self) seen.add(self.key);
  states.forEach((state, clientId) => {
    if (clientId === localId) return;
    const id = parseIdentity(state);
    if (!id) return;
    if (seen.has(id.key)) return;
    seen.add(id.key);
    users.push(
      id.avatarUrl
        ? { clientId, name: id.name, avatarUrl: id.avatarUrl }
        : { clientId, name: id.name },
    );
  });
  return users;
}

/**
 * Subscribe to awareness changes and post the peer list to the host. Posts once
 * immediately (so the host clears any stale list) and returns an unsubscribe.
 *
 * `post` is injectable for tests; defaults to the real `postToHost`.
 */
export function observePresence(
  awareness: AwarenessLike,
  hostOrigin: string,
  post: typeof postToHost = postToHost,
): () => void {
  const emit = () => {
    const users = mapAwarenessToUsers(awareness.getStates(), awareness.clientID);
    post(buildPresence(users), hostOrigin);
  };
  awareness.on("change", emit);
  emit();
  return () => awareness.off("change", emit);
}

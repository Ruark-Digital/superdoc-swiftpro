import { describe, it, expect, vi } from "vitest";
import { mapAwarenessToUsers, observePresence, type AwarenessLike } from "./presence";
import type { SuperdocOutbound } from "./bridge";

const states = (entries: Array<[number, unknown]>) => new Map<number, unknown>(entries);

describe("mapAwarenessToUsers", () => {
  it("excludes the local client", () => {
    const map = states([
      [1, { user: { name: "Me" } }],
      [2, { user: { name: "Ada" } }],
    ]);
    expect(mapAwarenessToUsers(map, 1)).toEqual([{ clientId: 2, name: "Ada" }]);
  });

  it("skips clients with no user name", () => {
    const map = states([
      [2, { user: {} }],
      [3, null],
      [4, { user: { name: "Grace" } }],
    ]);
    expect(mapAwarenessToUsers(map, 1)).toEqual([{ clientId: 4, name: "Grace" }]);
  });

  it("de-dupes by name + avatarUrl (same person, two tabs)", () => {
    const map = states([
      [2, { user: { name: "Ada" } }],
      [3, { user: { name: "Ada" } }],
    ]);
    expect(mapAwarenessToUsers(map, 1)).toEqual([{ clientId: 2, name: "Ada" }]);
  });

  it("carries avatarUrl through when present", () => {
    const map = states([[2, { user: { name: "Ada", avatarUrl: "a.png" } }]]);
    expect(mapAwarenessToUsers(map, 1)).toEqual([
      { clientId: 2, name: "Ada", avatarUrl: "a.png" },
    ]);
  });
});

describe("observePresence", () => {
  function fakeAwareness(initial: Array<[number, unknown]>): AwarenessLike & {
    fire: () => void;
    setStates: (e: Array<[number, unknown]>) => void;
    handlers: number;
  } {
    let current = states(initial);
    let cb: (() => void) | null = null;
    return {
      clientID: 1,
      getStates: () => current,
      on: (_e, fn) => {
        cb = fn;
      },
      off: () => {
        cb = null;
      },
      get handlers() {
        return cb ? 1 : 0;
      },
      setStates(e) {
        current = states(e);
      },
      fire() {
        cb?.();
      },
    };
  }

  it("posts the peer list immediately and on every change", () => {
    const aware = fakeAwareness([
      [1, { user: { name: "Me" } }],
      [2, { user: { name: "Ada" } }],
    ]);
    const post = vi.fn<(msg: SuperdocOutbound, origin: string) => void>();

    const stop = observePresence(aware, "https://host.example", post);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith(
      { type: "superdoc:presence", payload: { users: [{ clientId: 2, name: "Ada" }] } },
      "https://host.example",
    );

    aware.setStates([[1, { user: { name: "Me" } }]]);
    aware.fire();
    expect(post).toHaveBeenLastCalledWith(
      { type: "superdoc:presence", payload: { users: [] } },
      "https://host.example",
    );

    stop();
    expect(aware.handlers).toBe(0);
  });
});

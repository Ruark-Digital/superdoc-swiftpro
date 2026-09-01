import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DOC_FRAGMENT, connectWithTimeout } from "./collabProvider";

/** Populate the body fragment the way a seeded room arrives from the server. */
function seedBody(doc: Y.Doc): void {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("hello")]);
  doc.getXmlFragment(DOC_FRAGMENT).insert(0, [p]);
}

type Handler = (arg: boolean) => void;

function fakeProvider(opts: { syncAfterMs: number | null }) {
  const handlers: Record<string, Handler[]> = {};
  const provider = {
    on: (ev: string, cb: Handler) => {
      (handlers[ev] ??= []).push(cb);
    },
    destroy: vi.fn(),
    _emit: (ev: string, arg: boolean) => (handlers[ev] ?? []).forEach((h) => h(arg)),
  };
  if (opts.syncAfterMs !== null) {
    setTimeout(() => provider._emit("sync", true), opts.syncAfterMs);
  }
  return provider;
}

afterEach(() => vi.useRealTimers());

describe("connectWithTimeout", () => {
  it("resolves the handle when the provider syncs in time", async () => {
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: 100 });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 1000 },
      { createProvider: () => provider as never },
    );
    await vi.advanceTimersByTimeAsync(150);
    const handle = await promise;
    expect(handle).not.toBeNull();
    expect(provider.destroy).not.toHaveBeenCalled();
  });

  it("resolves null and destroys the provider on timeout", async () => {
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: null });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 1000 },
      { createProvider: () => provider as never },
    );
    await vi.advanceTimersByTimeAsync(1001);
    const handle = await promise;
    expect(handle).toBeNull();
    expect(provider.destroy).toHaveBeenCalled();
  });

  it("resolves null and destroys on connection-close before timeout", async () => {
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: null });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 10000 },
      { createProvider: () => provider as never },
    );
    await vi.advanceTimersByTimeAsync(50);
    provider._emit("connection-close", true);
    const handle = await promise;
    expect(handle).toBeNull();
    expect(provider.destroy).toHaveBeenCalled();
  });

  it("flags an empty synced room as new (needs seeding)", async () => {
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: 100 });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 1000 },
      { createProvider: () => provider as never }, // leaves the doc untouched (empty)
    );
    await vi.advanceTimersByTimeAsync(150);
    const handle = await promise;
    expect(handle?.isNewRoom).toBe(true);
  });

  it("flags a room with body content as not new (join, don't seed)", async () => {
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: 100 });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 1000 },
      {
        // Simulate a room the server delivers already carrying document content
        // in the body fragment (a prior client that finished seeding).
        createProvider: (_wsUrl, _room, doc) => {
          seedBody(doc);
          return provider as never;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(150);
    const handle = await promise;
    expect(handle?.isNewRoom).toBe(false);
  });

  it("flags a room with side structures but no body content as new (re-seed)", async () => {
    // Regression: opening a fresh doc then reloading showed a single blank page.
    // A seed can leave the server holding SuperDoc's side structures (a `meta`
    // bootstrap flag, a `media`/`comments` map) while the body fragment never
    // lands. `doc.share.size === 0` and a "seeded" marker both misread that as
    // populated → JOIN → blank. Only an empty body fragment must count as new so
    // the docx is re-seeded.
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: 100 });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 1000 },
      {
        createProvider: (_wsUrl, _room, doc) => {
          // Side structures present (share.size > 0), body fragment empty.
          doc.getMap("meta").set("bootstrap", true);
          doc.getMap("comments").set("x", 1);
          doc.getXmlFragment(DOC_FRAGMENT); // registered but empty
          return provider as never;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(150);
    const handle = await promise;
    expect(handle?.isNewRoom).toBe(true);
  });
});

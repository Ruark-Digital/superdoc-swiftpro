import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEED_MARKER_KEY,
  SEED_MARKER_MAP,
  connectWithTimeout,
} from "./collabProvider";

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

  it("flags a seeded synced room as not new (join, don't seed)", async () => {
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: 100 });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 1000 },
      {
        // Simulate a room the server delivers already carrying the seed marker
        // (mirrors a prior client that finished seeding and flushed).
        createProvider: (_wsUrl, _room, doc) => {
          doc.getMap(SEED_MARKER_MAP).set(SEED_MARKER_KEY, true);
          return provider as never;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(150);
    const handle = await promise;
    expect(handle?.isNewRoom).toBe(false);
  });

  it("flags a room with shared types but no seed marker as new (re-seed)", async () => {
    // Regression: "open a fresh doc → leave immediately → return" left the
    // server holding SuperDoc's shared types with no content and no marker. The
    // old `doc.share.size === 0` check misread that as populated → JOIN → a
    // single blank page. It must now read as new so the docx is re-seeded.
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: 100 });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 1000 },
      {
        createProvider: (_wsUrl, _room, doc) => {
          // Shared types exist (share.size > 0) but the room was never marked
          // seeded — a half-flushed seed.
          doc.getMap("comments").set("x", 1);
          doc.getXmlFragment("body");
          return provider as never;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(150);
    const handle = await promise;
    expect(handle?.isNewRoom).toBe(true);
  });
});

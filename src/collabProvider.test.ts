import { afterEach, describe, expect, it, vi } from "vitest";
import { connectWithTimeout } from "./collabProvider";

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
});

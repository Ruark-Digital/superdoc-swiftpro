import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DOC_FRAGMENT, connectWithTimeout, fragmentHasContent } from "./collabProvider";

/** Populate the body fragment the way a seeded room arrives from the server. */
function seedBody(doc: Y.Doc): void {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("hello")]);
  doc.getXmlFragment(DOC_FRAGMENT).insert(0, [p]);
}

/** A poisoned room: a single empty paragraph (fragment length 1, zero text). */
function seedEmptyParagraph(doc: Y.Doc): void {
  doc.getXmlFragment(DOC_FRAGMENT).insert(0, [new Y.XmlElement("paragraph")]);
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

  it("flags a room holding only an empty paragraph as new (re-seed the poison)", async () => {
    // Regression: a bad seed from an older build left the room body with a
    // single empty `paragraph` node. `length > 0` read it as populated, so every
    // reload JOINed it and painted a permanently blank page. It must count as
    // new so the docx re-seeds and the room self-heals.
    vi.useFakeTimers();
    const provider = fakeProvider({ syncAfterMs: 100 });
    const promise = connectWithTimeout(
      { wsUrl: "wss://x/y", roomId: "r-superdoc", token: "t", timeoutMs: 1000 },
      {
        createProvider: (_wsUrl, _room, doc) => {
          seedEmptyParagraph(doc);
          return provider as never;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(150);
    const handle = await promise;
    expect(handle?.isNewRoom).toBe(true);
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

describe("fragmentHasContent", () => {
  function frag(build: (f: Y.XmlFragment) => void): Y.XmlFragment {
    const f = new Y.Doc().getXmlFragment(DOC_FRAGMENT);
    build(f);
    return f;
  }

  it("is false for an empty fragment", () => {
    expect(fragmentHasContent(frag(() => {}))).toBe(false);
  });

  it("is false for a single empty paragraph (the poison)", () => {
    expect(
      fragmentHasContent(frag((f) => f.insert(0, [new Y.XmlElement("paragraph")]))),
    ).toBe(false);
  });

  it("is false for several empty paragraphs", () => {
    expect(
      fragmentHasContent(
        frag((f) =>
          f.insert(0, [
            new Y.XmlElement("paragraph"),
            new Y.XmlElement("paragraph"),
          ]),
        ),
      ),
    ).toBe(false);
  });

  it("is true for a paragraph carrying text", () => {
    expect(
      fragmentHasContent(
        frag((f) => {
          const p = new Y.XmlElement("paragraph");
          p.insert(0, [new Y.XmlText("hello")]);
          f.insert(0, [p]);
        }),
      ),
    ).toBe(true);
  });

  it("is true for a non-paragraph element even with no text (image/table)", () => {
    expect(
      fragmentHasContent(frag((f) => f.insert(0, [new Y.XmlElement("table")]))),
    ).toBe(true);
  });

  it("is true when text is nested under an empty-looking paragraph's child run", () => {
    expect(
      fragmentHasContent(
        frag((f) => {
          const p = new Y.XmlElement("paragraph");
          const run = new Y.XmlElement("run");
          run.insert(0, [new Y.XmlText("nested")]);
          p.insert(0, [run]);
          f.insert(0, [p]);
        }),
      ),
    ).toBe(true);
  });
});

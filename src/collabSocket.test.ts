import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGE_AWARENESS,
  collabSubprotocols,
  makeThrottledSend,
  messageType,
  rewriteCollabUrl,
} from "./collabSocket";

describe("rewriteCollabUrl", () => {
  it("moves the room into ?doc= and points at the /collab endpoint", () => {
    const out = rewriteCollabUrl(
      "wss://api.swiftpro.tech/api/v1/dev/contract/room123-superdoc",
      "room123-superdoc",
    );
    const u = new URL(out);
    expect(u.pathname).toBe("/api/v1/dev/contract/collab");
    expect(u.searchParams.get("doc")).toBe("room123-superdoc");
  });

  it("does not duplicate the collab segment if already present", () => {
    const out = rewriteCollabUrl(
      "wss://api.swiftpro.tech/api/v1/dev/contract/collab/room123-superdoc",
      "room123-superdoc",
    );
    expect(new URL(out).pathname).toBe("/api/v1/dev/contract/collab");
  });

  it("returns the input unchanged when it is not parseable", () => {
    expect(rewriteCollabUrl("not a url", "room")).toBe("not a url");
  });
});

describe("collabSubprotocols", () => {
  it("uses the access_token subprotocol when a token is present", () => {
    expect(collabSubprotocols("jwt-abc", undefined)).toEqual(["access_token", "jwt-abc"]);
  });
  it("falls back to the given protocols when no token", () => {
    expect(collabSubprotocols(undefined, "x")).toBe("x");
  });
});

describe("messageType", () => {
  it("reads the first byte of a Uint8Array (awareness = 1, sync = 0)", () => {
    expect(messageType(new Uint8Array([MESSAGE_AWARENESS, 9, 9]))).toBe(MESSAGE_AWARENESS);
    expect(messageType(new Uint8Array([0, 1, 2]))).toBe(0);
  });
  it("reads the first byte of an ArrayBuffer", () => {
    expect(messageType(new Uint8Array([1, 2]).buffer)).toBe(1);
  });
  it("returns -1 for empty or non-binary payloads", () => {
    expect(messageType(new Uint8Array([]))).toBe(-1);
    expect(messageType("text")).toBe(-1);
  });
});

describe("makeThrottledSend", () => {
  afterEach(() => vi.useRealTimers());

  const awareness = () => new Uint8Array([MESSAGE_AWARENESS, Math.floor(Math.random() * 250)]);
  const sync = (n: number) => new Uint8Array([0, n]);

  it("passes non-awareness (doc-sync) frames straight through, unthrottled", () => {
    const sent: unknown[] = [];
    const send = makeThrottledSend((d) => sent.push(d), () => true, 33);
    send(sync(1));
    send(sync(2));
    expect(sent).toHaveLength(2);
  });

  it("coalesces a burst of awareness frames into one trailing send (latest wins)", () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    const send = makeThrottledSend((d) => sent.push(d as Uint8Array), () => true, 33);
    const first = awareness();
    const last = awareness();
    send(first);
    send(awareness());
    send(last);
    expect(sent).toHaveLength(0); // nothing sent synchronously
    vi.advanceTimersByTime(33);
    expect(sent).toEqual([last]); // only the most recent state is flushed
  });

  it("drops the flush if the socket closed before the timer fires", () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    let open = true;
    const send = makeThrottledSend((d) => sent.push(d), () => open, 33);
    send(awareness());
    open = false;
    vi.advanceTimersByTime(33);
    expect(sent).toHaveLength(0);
  });

  it("starts a fresh throttle window after a flush", () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const send = makeThrottledSend((d) => sent.push(d), () => true, 33);
    send(awareness());
    vi.advanceTimersByTime(33);
    send(awareness());
    vi.advanceTimersByTime(33);
    expect(sent).toHaveLength(2);
  });
});

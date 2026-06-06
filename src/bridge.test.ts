import { describe, it, expect, vi } from "vitest";
import { parseHostMessage, postToHost, parseHostCommand, buildRedlines, buildRedlineClicked, type SuperdocOutbound } from "./bridge";

const HOST = "http://localhost:5173";
const EVIL = "http://evil.example.com";

/** Build a minimal MessageEvent-like object (we only read .origin and .data). */
function msg(origin: string, data: unknown): MessageEvent {
  return { origin, data } as MessageEvent;
}

function validInitData(overrides: Record<string, unknown> = {}) {
  return {
    type: "superdoc:init",
    payload: {
      docBytes: new ArrayBuffer(8),
      fileName: "contract.docx",
      fileType: "docx",
      documentMode: "editing",
      user: { name: "Ada", email: "ada@example.com" },
      roomId: "room-42:superdoc",
      wsUrl: "ws://localhost:1234",
      token: "t",
      ...overrides,
    },
  };
}

describe("parseHostMessage — origin check", () => {
  it("rejects messages from a foreign origin", () => {
    expect(parseHostMessage(msg(EVIL, validInitData()), HOST)).toBeNull();
  });

  it("accepts a well-formed message from the host origin", () => {
    const result = parseHostMessage(msg(HOST, validInitData()), HOST);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("superdoc:init");
  });
});

describe("parseHostMessage — shape validation", () => {
  it("rejects a wrong message type", () => {
    expect(parseHostMessage(msg(HOST, { type: "something-else" }), HOST)).toBeNull();
  });

  it("rejects non-object data", () => {
    expect(parseHostMessage(msg(HOST, "superdoc:init"), HOST)).toBeNull();
    expect(parseHostMessage(msg(HOST, null), HOST)).toBeNull();
  });

  it("rejects when docBytes is not an ArrayBuffer", () => {
    const data = validInitData({ docBytes: "not-bytes" });
    expect(parseHostMessage(msg(HOST, data), HOST)).toBeNull();
  });

  it("rejects a missing/empty roomId", () => {
    expect(parseHostMessage(msg(HOST, validInitData({ roomId: "" })), HOST)).toBeNull();
    expect(parseHostMessage(msg(HOST, validInitData({ roomId: undefined })), HOST)).toBeNull();
  });

  it("rejects a missing wsUrl", () => {
    expect(parseHostMessage(msg(HOST, validInitData({ wsUrl: undefined })), HOST)).toBeNull();
  });

  it("rejects a malformed user", () => {
    expect(parseHostMessage(msg(HOST, validInitData({ user: { name: "Ada" } })), HOST)).toBeNull();
    expect(parseHostMessage(msg(HOST, validInitData({ user: null })), HOST)).toBeNull();
  });
});

describe("parseHostMessage — passthrough & defaults", () => {
  it("uses payload.roomId verbatim (does not strip/append :superdoc)", () => {
    const result = parseHostMessage(msg(HOST, validInitData({ roomId: "abc:superdoc" })), HOST);
    expect(result?.payload.roomId).toBe("abc:superdoc");
  });

  it("defaults documentMode to 'editing' when absent", () => {
    const result = parseHostMessage(msg(HOST, validInitData({ documentMode: undefined })), HOST);
    expect(result?.payload.documentMode).toBe("editing");
  });

  it("defaults documentMode to 'editing' when invalid", () => {
    const result = parseHostMessage(msg(HOST, validInitData({ documentMode: "scribbling" })), HOST);
    expect(result?.payload.documentMode).toBe("editing");
  });

  it("preserves valid non-default documentMode", () => {
    const result = parseHostMessage(msg(HOST, validInitData({ documentMode: "suggesting" })), HOST);
    expect(result?.payload.documentMode).toBe("suggesting");
  });
});

describe("redline messages", () => {
  it("parseHostCommand accepts apply-redline from the host origin", () => {
    const r = parseHostCommand(msg(HOST, { type: "superdoc:apply-redline", payload: { redlineId: "r1", replacement: "x" } }), HOST);
    expect(r).toEqual({ type: "superdoc:apply-redline", payload: { redlineId: "r1", replacement: "x" } });
  });
  it("parseHostCommand accepts focus-redline", () => {
    const r = parseHostCommand(msg(HOST, { type: "superdoc:focus-redline", payload: { redlineId: "r1" } }), HOST);
    expect(r).toEqual({ type: "superdoc:focus-redline", payload: { redlineId: "r1" } });
  });
  it("parseHostCommand rejects a foreign origin", () => {
    expect(parseHostCommand(msg(EVIL, { type: "superdoc:focus-redline", payload: { redlineId: "r1" } }), HOST)).toBeNull();
  });
  it("parseHostCommand rejects malformed apply-redline", () => {
    expect(parseHostCommand(msg(HOST, { type: "superdoc:apply-redline", payload: { redlineId: "r1" } }), HOST)).toBeNull();
    expect(parseHostCommand(msg(HOST, { type: "superdoc:apply-redline" }), HOST)).toBeNull();
  });
  it("parseHostCommand returns null for non-command types", () => {
    expect(parseHostCommand(msg(HOST, { type: "superdoc:init" }), HOST)).toBeNull();
  });
  it("buildRedlines posts the array", () => {
    expect(buildRedlines([{ redlineId: "r1", kind: "insertion", text: "x" }])).toEqual({
      type: "superdoc:redlines", payload: { redlines: [{ redlineId: "r1", kind: "insertion", text: "x" }] },
    });
  });
  it("buildRedlineClicked", () => {
    expect(buildRedlineClicked("r1")).toEqual({ type: "superdoc:redline-clicked", payload: { redlineId: "r1" } });
  });
});

describe("postToHost", () => {
  it("targets the exact host origin (never '*')", () => {
    const target = { postMessage: vi.fn() };
    const out: SuperdocOutbound = { type: "superdoc:ready" };
    postToHost(out, HOST, target);
    expect(target.postMessage).toHaveBeenCalledWith(out, HOST);
  });

  it("forwards editor-ready with a pageCount payload", () => {
    const target = { postMessage: vi.fn() };
    postToHost({ type: "superdoc:editor-ready", payload: { pageCount: 3 } }, HOST, target);
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: "superdoc:editor-ready", payload: { pageCount: 3 } },
      HOST,
    );
  });
});

describe("parseHostMessage token", () => {
  const hostOrigin = "https://app.swiftpro.tech";
  const validData = {
    type: "superdoc:init",
    payload: {
      docBytes: new ArrayBuffer(8),
      fileName: "a.docx",
      fileType: "docx",
      documentMode: "editing",
      user: { name: "A", email: "a@b.c" },
      roomId: "room123-superdoc",
      wsUrl: "wss://api.swiftpro.tech/api/v1/dev/contract",
      token: "jwt-abc",
    },
  };

  it("returns the token when present", () => {
    const ev = { origin: hostOrigin, data: validData } as MessageEvent;
    expect(parseHostMessage(ev, hostOrigin)?.payload.token).toBe("jwt-abc");
  });

  it("rejects when token is missing", () => {
    const { token: _omit, ...noToken } = validData.payload;
    const ev = { origin: hostOrigin, data: { type: "superdoc:init", payload: noToken } } as MessageEvent;
    expect(parseHostMessage(ev, hostOrigin)).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  MESSAGE_CONNECTED_CLIENTS,
  MESSAGE_MY_INFO,
  MESSAGE_ERROR,
  readConnectedClients,
  registerCustomMessageHandlers,
} from "./collabMessages";

/**
 * Build a full wire frame (type varUint + payload) the way the server does, then
 * hand back a decoder positioned past the type byte — exactly what y-websocket's
 * `readMessage` gives a message handler.
 */
function frame(build: (enc: encoding.Encoder) => void): decoding.Decoder {
  const enc = encoding.createEncoder();
  build(enc);
  const decoder = decoding.createDecoder(encoding.toUint8Array(enc));
  decoding.readVarUint(decoder); // consume the message type
  return decoder;
}

describe("readConnectedClients", () => {
  it("reads the count and each name in order", () => {
    const decoder = frame((enc) => {
      encoding.writeVarUint(enc, MESSAGE_CONNECTED_CLIENTS);
      encoding.writeVarUint(enc, 2);
      encoding.writeVarString(enc, "Ada");
      encoding.writeVarString(enc, "Grace");
    });
    expect(readConnectedClients(decoder)).toEqual({ count: 2, names: ["Ada", "Grace"] });
  });

  it("reads an empty roster", () => {
    const decoder = frame((enc) => {
      encoding.writeVarUint(enc, MESSAGE_CONNECTED_CLIENTS);
      encoding.writeVarUint(enc, 0);
    });
    expect(readConnectedClients(decoder)).toEqual({ count: 0, names: [] });
  });
});

/** Minimal provider stand-in: y-websocket seeds `messageHandlers` as an array. */
function fakeProvider() {
  return { messageHandlers: [] as unknown[] };
}

/** Invoke the handler registered for `type` with a decoder past the type byte. */
function dispatch(
  provider: { messageHandlers: unknown[] },
  type: number,
  build: (enc: encoding.Encoder) => void,
): void {
  const handler = provider.messageHandlers[type] as
    | ((encoder: unknown, decoder: decoding.Decoder) => void)
    | undefined;
  if (!handler) throw new Error(`no handler for type ${type}`);
  handler(encoding.createEncoder(), frame(build));
}

describe("registerCustomMessageHandlers", () => {
  it("routes a connected-clients frame to onConnectedClients", () => {
    const onConnectedClients = vi.fn();
    const provider = fakeProvider();
    registerCustomMessageHandlers(provider, { onConnectedClients });

    dispatch(provider, MESSAGE_CONNECTED_CLIENTS, (enc) => {
      encoding.writeVarUint(enc, MESSAGE_CONNECTED_CLIENTS);
      encoding.writeVarUint(enc, 1);
      encoding.writeVarString(enc, "Ada");
    });

    expect(onConnectedClients).toHaveBeenCalledWith({ count: 1, names: ["Ada"] });
  });

  it("routes a my-info frame to onMyInfo", () => {
    const onMyInfo = vi.fn();
    const provider = fakeProvider();
    registerCustomMessageHandlers(provider, { onMyInfo });

    dispatch(provider, MESSAGE_MY_INFO, (enc) => {
      encoding.writeVarUint(enc, MESSAGE_MY_INFO);
      encoding.writeVarString(enc, "Ada Lovelace");
    });

    expect(onMyInfo).toHaveBeenCalledWith("Ada Lovelace");
  });

  it("routes an error frame to onError", () => {
    const onError = vi.fn();
    const provider = fakeProvider();
    registerCustomMessageHandlers(provider, { onError });

    dispatch(provider, MESSAGE_ERROR, (enc) => {
      encoding.writeVarUint(enc, MESSAGE_ERROR);
      encoding.writeVarString(enc, "message too large");
    });

    expect(onError).toHaveBeenCalledWith("message too large");
  });

  it("leaves the reserved y-websocket types (0-3) untouched", () => {
    const provider = fakeProvider();
    registerCustomMessageHandlers(provider, { onError: vi.fn() });
    expect(provider.messageHandlers[0]).toBeUndefined();
    expect(provider.messageHandlers[1]).toBeUndefined();
    expect(provider.messageHandlers[2]).toBeUndefined();
    expect(provider.messageHandlers[3]).toBeUndefined();
  });

  it("no-ops when messageHandlers is not an array", () => {
    expect(() =>
      registerCustomMessageHandlers({ messageHandlers: undefined }, { onError: vi.fn() }),
    ).not.toThrow();
  });

  it("does not send a reply (handler writes nothing to the encoder)", () => {
    const provider = fakeProvider();
    registerCustomMessageHandlers(provider, { onError: vi.fn() });
    const encoder = encoding.createEncoder();
    const handler = provider.messageHandlers[MESSAGE_ERROR] as (
      encoder: unknown,
      decoder: decoding.Decoder,
    ) => void;
    handler(
      encoder,
      frame((enc) => {
        encoding.writeVarUint(enc, MESSAGE_ERROR);
        encoding.writeVarString(enc, "boom");
      }),
    );
    // y-websocket only replies when the encoder holds more than the type byte.
    expect(encoding.length(encoder)).toBe(0);
  });
});

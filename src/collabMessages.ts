/**
 * SwiftPro collab-server custom WebSocket messages.
 *
 * The backend multiplexes three of its own message types over the same socket
 * y-websocket uses for Yjs sync/awareness. y-websocket dispatches every inbound
 * frame by its first varUint (the message type) through `provider.messageHandlers`
 * — an unknown type just logs `console.error('Unable to compute message')` and is
 * dropped. We register handlers for the custom types so they're decoded and
 * surfaced instead of silently discarded.
 *
 * IMPORTANT — numbering. y-websocket reserves the low types: 0 sync, 1 awareness,
 * 2 auth, **3 queryAwareness** (the client even sends type 3 outbound on every
 * connect). The backend's original custom numbering (2 = connected-clients,
 * 3 = my-info, 4 = error) collides with auth/queryAwareness in both directions,
 * so we use a non-reserved range here. The server must send these same numbers.
 */
import * as decoding from "lib0/decoding";

/** Server → client: who is currently in the room. Payload: varUint count, then `count` varString names. */
export const MESSAGE_CONNECTED_CLIENTS = 100;
/** Server → client: this client's resolved display name. Payload: one varString. */
export const MESSAGE_MY_INFO = 101;
/** Server → client: a non-fatal error string (e.g. an oversized frame the server rejected without closing). Payload: one varString. */
export const MESSAGE_ERROR = 102;

/** Decoded {@link MESSAGE_CONNECTED_CLIENTS} payload. */
export interface ConnectedClients {
  count: number;
  names: string[];
}

/** Callbacks invoked when a custom message is received. All optional. */
export interface CollabMessageHandlers {
  onConnectedClients?: (clients: ConnectedClients) => void;
  onMyInfo?: (name: string) => void;
  onError?: (message: string) => void;
}

/**
 * Read a {@link MESSAGE_CONNECTED_CLIENTS} payload from a decoder positioned
 * just after the message-type byte (as y-websocket hands it to a message
 * handler). Exported for unit testing against a plain lib0 decoder.
 */
export function readConnectedClients(decoder: decoding.Decoder): ConnectedClients {
  const count = decoding.readVarUint(decoder);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    names.push(decoding.readVarString(decoder));
  }
  return { count, names };
}

/** The subset of a y-websocket provider we touch — an indexable handler array. */
interface MessageHandlerHost {
  messageHandlers?: unknown;
}

/** y-websocket message-handler signature: the decoder arrives positioned past the type byte. */
type MessageHandler = (encoder: unknown, decoder: decoding.Decoder) => void;

/**
 * Register handlers for the custom message types on a y-websocket provider.
 *
 * Each handler reads its payload and forwards it to `handlers`; none write to the
 * encoder, so y-websocket sends no reply (it only replies when the encoder holds
 * more than the message-type byte). Types 0/1/2/3 are left untouched, so Yjs
 * sync, awareness, auth and queryAwareness keep working.
 *
 * No-ops safely when `provider.messageHandlers` isn't an array (e.g. a test
 * fake), so callers don't need to guard.
 */
export function registerCustomMessageHandlers(
  provider: MessageHandlerHost,
  handlers: CollabMessageHandlers,
): void {
  const table = provider.messageHandlers;
  if (!Array.isArray(table)) return;

  table[MESSAGE_CONNECTED_CLIENTS] = ((_encoder, decoder) => {
    handlers.onConnectedClients?.(readConnectedClients(decoder));
  }) as MessageHandler;

  table[MESSAGE_MY_INFO] = ((_encoder, decoder) => {
    handlers.onMyInfo?.(decoding.readVarString(decoder));
  }) as MessageHandler;

  table[MESSAGE_ERROR] = ((_encoder, decoder) => {
    handlers.onError?.(decoding.readVarString(decoder));
  }) as MessageHandler;
}

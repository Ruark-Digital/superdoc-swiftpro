import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { buildSuperdocOptions, type SuperdocHandlers } from "./superdocOptions";
import type { SuperdocInit } from "./bridge";

const payload: SuperdocInit["payload"] = {
  docBytes: new ArrayBuffer(8),
  fileName: "contract.docx",
  fileType: "docx",
  documentMode: "editing",
  user: { name: "Ada", email: "ada@example.com" },
  roomId: "room-42:superdoc",
  wsUrl: "ws://localhost:1234",
  token: "t",
};

const handlers: SuperdocHandlers = {
  onReady: vi.fn(),
  onPaginationUpdate: vi.fn(),
  onEditorUpdate: vi.fn(),
  onException: vi.fn(),
  onContentError: vi.fn(),
};

describe("buildSuperdocOptions", () => {
  it("renders document-only — NO collaboration module (collab must not gate rendering)", () => {
    const opts = buildSuperdocOptions(payload, handlers) as { modules?: { collaboration?: unknown } };
    // Regression guard: a collaboration provider would make SuperDoc wait for
    // WS sync before onReady, hanging the editor when the server is unreachable.
    expect(opts.modules?.collaboration).toBeUndefined();
  });

  it("hides the documentMode toolbar item via excludeItems", () => {
    const opts = buildSuperdocOptions(payload, handlers) as {
      modules?: { toolbar?: { excludeItems?: string[] } };
    };
    expect(opts.modules?.toolbar?.excludeItems).toContain("documentMode");
  });

  it("builds a .docx Blob document from the transferred bytes", () => {
    const opts = buildSuperdocOptions(payload, handlers);
    expect(opts.document).toBeInstanceOf(Blob);
    expect((opts.document as Blob).type).toContain("wordprocessingml");
  });

  it("passes documentMode, user, and the lifecycle handlers through", () => {
    const opts = buildSuperdocOptions(payload, handlers);
    expect(opts.documentMode).toBe("editing");
    expect(opts.user).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(opts.onReady).toBe(handlers.onReady);
    expect(opts.onContentError).toBe(handlers.onContentError);
  });
});

describe("buildSuperdocOptions collaboration", () => {
  it("omits modules.collaboration when no collab handle is given", () => {
    const opts = buildSuperdocOptions(payload, handlers) as { modules?: { collaboration?: unknown } };
    expect(opts.modules?.collaboration).toBeUndefined();
  });

  it("adds modules.collaboration when a synced handle is given", () => {
    const doc = new Y.Doc();
    const provider = {} as never;
    const opts = buildSuperdocOptions(payload, handlers, { doc, provider, isNewRoom: false }) as {
      modules?: { collaboration?: { ydoc: unknown; provider: unknown } };
    };
    expect(opts.modules?.collaboration?.ydoc).toBe(doc);
    expect(opts.modules?.collaboration?.provider).toBe(provider);
  });
});

import { describe, expect, it } from "vitest";
import { collabSubprotocols, rewriteCollabUrl } from "./collabSocket";

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

import { describe, expect, it } from "vitest";
import { resolveHostOrigin } from "./env";

describe("resolveHostOrigin", () => {
  it("returns the configured origin when set", () => {
    expect(resolveHostOrigin({ VITE_HOST_ORIGIN: "https://app.swiftpro.tech", PROD: true }))
      .toBe("https://app.swiftpro.tech");
  });

  it("falls back to localhost in dev when unset", () => {
    expect(resolveHostOrigin({ VITE_HOST_ORIGIN: undefined, PROD: false }))
      .toBe("http://localhost:5173");
  });

  it("throws in a production build when unset", () => {
    expect(() => resolveHostOrigin({ VITE_HOST_ORIGIN: undefined, PROD: true }))
      .toThrow(/VITE_HOST_ORIGIN/);
  });
});

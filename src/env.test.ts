import { describe, expect, it } from "vitest";
import { resolveHostOrigins } from "./env";

describe("resolveHostOrigins", () => {
  it("returns a single normalized origin when one is set", () => {
    expect(resolveHostOrigins({ VITE_HOST_ORIGIN: "https://app.swiftpro.tech", PROD: true }))
      .toEqual(["https://app.swiftpro.tech"]);
  });

  it("strips a trailing slash / path (origin-normalizes) so it matches event.origin", () => {
    // event.origin is NEVER trailing-slashed; a console-entered value often is.
    expect(resolveHostOrigins({ VITE_HOST_ORIGIN: "https://swiftpro.tech/", PROD: true }))
      .toEqual(["https://swiftpro.tech"]);
  });

  it("splits a comma-separated allowlist and normalizes each", () => {
    expect(
      resolveHostOrigins({
        VITE_HOST_ORIGIN: "https://swiftpro.tech/, https://staging.swiftpro.tech/ ,https://bug.swiftpro.tech",
        PROD: true,
      }),
    ).toEqual([
      "https://swiftpro.tech",
      "https://staging.swiftpro.tech",
      "https://bug.swiftpro.tech",
    ]);
  });

  it("dedupes and drops unparseable entries", () => {
    expect(
      resolveHostOrigins({ VITE_HOST_ORIGIN: "https://a.tech, not-a-url, https://a.tech/", PROD: true }),
    ).toEqual(["https://a.tech"]);
  });

  it("falls back to localhost in dev when unset", () => {
    expect(resolveHostOrigins({ VITE_HOST_ORIGIN: undefined, PROD: false }))
      .toEqual(["http://localhost:5173"]);
  });

  it("throws in a production build when unset", () => {
    expect(() => resolveHostOrigins({ VITE_HOST_ORIGIN: undefined, PROD: true }))
      .toThrow(/VITE_HOST_ORIGIN/);
  });
});

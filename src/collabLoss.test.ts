import { describe, expect, it, vi } from "vitest";
import { createLossTracker } from "./collabLoss";

describe("createLossTracker", () => {
  it("reports loss after consecutive failures and only once", () => {
    const onLost = vi.fn();
    const t = createLossTracker(onLost, 3);
    t.onFailure(1006);
    t.onFailure(1006);
    expect(onLost).not.toHaveBeenCalled();
    t.onFailure(1006);
    t.onFailure(1006);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith({ reason: "retries-exhausted", attempts: 3 });
  });

  it("a successful connect resets the streak", () => {
    const onLost = vi.fn();
    const t = createLossTracker(onLost, 3);
    t.onFailure();
    t.onFailure();
    t.onConnected();
    t.onFailure();
    t.onFailure();
    expect(onLost).not.toHaveBeenCalled();
  });

  it("stops at once when replaced by another tab (4000)", () => {
    const onLost = vi.fn();
    createLossTracker(onLost).onFailure(4000);
    expect(onLost).toHaveBeenCalledWith({ reason: "replaced", attempts: 0 });
  });

  it("reports an initial sync failure immediately", () => {
    const onLost = vi.fn();
    createLossTracker(onLost).onInitialFailure();
    expect(onLost).toHaveBeenCalledWith({ reason: "initial-sync-failed", attempts: 1 });
  });
});

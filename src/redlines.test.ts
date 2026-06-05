import { describe, it, expect, vi } from "vitest";
import type { Editor } from "@harbour-enterprises/superdoc";
import {
  activeRedlineId,
  applyRedline,
  extractRedlines,
  focusRedline,
  trackedChangeToSpan,
} from "./redlines";

/**
 * Build a minimal fake editor whose `doc` surface returns the given
 * tracked-change list items and records mutation calls.
 */
function fakeEditor(opts: {
  items?: unknown[];
  activeChangeIds?: string[];
  onReplace?: (input: unknown, options: unknown) => void;
  onDecide?: (input: unknown) => void;
  listThrows?: boolean;
}): Editor {
  const doc = {
    trackChanges: {
      list: () => {
        if (opts.listThrows) throw new Error("boom");
        return { items: opts.items ?? [] };
      },
      decide: (input: unknown) => opts.onDecide?.(input),
    },
    replace: (input: unknown, options: unknown) => opts.onReplace?.(input, options),
    selection: {
      current: () => ({ activeChangeIds: opts.activeChangeIds ?? [] }),
    },
  };
  return { doc } as unknown as Editor;
}

describe("trackedChangeToSpan", () => {
  it("maps an insertion with inserted text + author + date", () => {
    expect(
      trackedChangeToSpan({
        id: "tc1",
        type: "insert",
        insertedText: "hello",
        author: "Ada",
        date: "2026-01-01",
      }),
    ).toEqual({
      redlineId: "tc1",
      kind: "insertion",
      text: "hello",
      author: "Ada",
      createdAt: "2026-01-01",
    });
  });

  it("maps a deletion using deletedText", () => {
    expect(trackedChangeToSpan({ id: "tc2", type: "delete", deletedText: "bye" })).toEqual({
      redlineId: "tc2",
      kind: "deletion",
      text: "bye",
    });
  });

  it("folds replacement/format to insertion and falls back to excerpt", () => {
    expect(trackedChangeToSpan({ id: "tc3", type: "replacement", excerpt: "x" })).toMatchObject({
      kind: "insertion",
      text: "x",
    });
    expect(trackedChangeToSpan({ id: "tc4", type: "format", excerpt: "y" })).toMatchObject({
      kind: "insertion",
    });
  });

  it("returns null for unknown types and missing ids", () => {
    expect(trackedChangeToSpan({ id: "tc5", type: "weird" })).toBeNull();
    expect(trackedChangeToSpan({ id: "", type: "insert" })).toBeNull();
  });
});

describe("extractRedlines", () => {
  it("returns [] for a null editor", () => {
    expect(extractRedlines(null)).toEqual([]);
  });

  it("returns [] when the list call throws (defensive)", () => {
    expect(extractRedlines(fakeEditor({ listThrows: true }))).toEqual([]);
  });

  it("maps and de-dupes by redlineId (first wins)", () => {
    const editor = fakeEditor({
      items: [
        { id: "dup", type: "insert", insertedText: "first" },
        { id: "dup", type: "insert", insertedText: "second" },
        { id: "other", type: "delete", deletedText: "gone" },
        { id: "skip", type: "unknown" },
      ],
    });
    expect(extractRedlines(editor)).toEqual([
      { redlineId: "dup", kind: "insertion", text: "first" },
      { redlineId: "other", kind: "deletion", text: "gone" },
    ]);
  });
});

describe("applyRedline", () => {
  it("does nothing when the id is not found", () => {
    const onReplace = vi.fn();
    applyRedline(fakeEditor({ items: [], onReplace }), "missing", "x");
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("replaces by ref (direct) then accepts the change", () => {
    const onReplace = vi.fn();
    const onDecide = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", handle: { ref: "ref-1" } }],
      onReplace,
      onDecide,
    });
    applyRedline(editor, "tc1", "new text");
    expect(onReplace).toHaveBeenCalledWith(
      { ref: "ref-1", text: "new text" },
      { changeMode: "direct" },
    );
    expect(onDecide).toHaveBeenCalledWith({ decision: "accept", target: { id: "tc1" } });
  });

  it("does not accept if the replace throws", () => {
    const onDecide = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", handle: { ref: "ref-1" } }],
      onReplace: () => {
        throw new Error("replace failed");
      },
      onDecide,
    });
    applyRedline(editor, "tc1", "x");
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("activeRedlineId", () => {
  it("returns the first active change id, or null", () => {
    expect(activeRedlineId(fakeEditor({ activeChangeIds: ["a", "b"] }))).toBe("a");
    expect(activeRedlineId(fakeEditor({ activeChangeIds: [] }))).toBeNull();
    expect(activeRedlineId(null)).toBeNull();
  });
});

describe("focusRedline", () => {
  it("calls navigateTo with a tracked-change entity address", () => {
    const navigateTo = vi.fn().mockResolvedValue(true);
    focusRedline({ navigateTo } as never, "tc9");
    expect(navigateTo).toHaveBeenCalledWith({
      kind: "entity",
      entityType: "trackedChange",
      entityId: "tc9",
    });
  });

  it("no-ops on null instance or empty id", () => {
    const navigateTo = vi.fn();
    focusRedline(null, "tc9");
    focusRedline({ navigateTo } as never, "");
    expect(navigateTo).not.toHaveBeenCalled();
  });
});

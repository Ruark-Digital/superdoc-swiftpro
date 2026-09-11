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
/** A mutation-ready selection target as `find` returns in `context.target`. */
const FAKE_TARGET = { kind: "selection", start: {}, end: {} };

function fakeEditor(opts: {
  items?: unknown[];
  activeChangeIds?: string[];
  onReplace?: (input: unknown, options: unknown) => void;
  onDecide?: (input: unknown) => void;
  onFind?: (selector: unknown) => void;
  /** Override the `find` result; defaults to one match carrying FAKE_TARGET. */
  findResult?: unknown;
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
    query: {
      match: (selector: unknown) => {
        opts.onFind?.(selector);
        return opts.findResult === undefined
          ? { items: [{ target: FAKE_TARGET }] }
          : opts.findResult;
      },
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

  it("text-searches the change content, replaces the match target (direct), then accepts", () => {
    const onReplace = vi.fn();
    const onDecide = vi.fn();
    const onFind = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", insertedText: "the inserted clause" }],
      onFind,
      onReplace,
      onDecide,
    });
    applyRedline(editor, "tc1", "new text");
    expect(onFind).toHaveBeenCalledWith({
      type: "text",
      pattern: "the inserted clause",
      caseSensitive: true,
    });
    expect(onReplace).toHaveBeenCalledWith(
      { target: FAKE_TARGET, text: "new text" },
      { changeMode: "direct" },
    );
    expect(onDecide).toHaveBeenCalledWith({ decision: "accept", target: { id: "tc1" } });
  });

  it("reads the target from the QueryResult `context[]` shape too", () => {
    const onReplace = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", insertedText: "clause" }],
      findResult: { context: [{ target: FAKE_TARGET }] },
      onReplace,
    });
    applyRedline(editor, "tc1", "x");
    expect(onReplace).toHaveBeenCalledWith(
      { target: FAKE_TARGET, text: "x" },
      { changeMode: "direct" },
    );
  });

  it("does not replace when the change has no searchable text", () => {
    const onFind = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", handle: { ref: "tc::body::tc1" } }],
      onFind,
    });
    applyRedline(editor, "tc1", "x");
    expect(onFind).not.toHaveBeenCalled();
  });

  it("does not replace when find yields no target", () => {
    const onReplace = vi.fn();
    const onDecide = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", insertedText: "clause" }],
      findResult: { items: [] },
      onReplace,
      onDecide,
    });
    applyRedline(editor, "tc1", "x");
    expect(onReplace).not.toHaveBeenCalled();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("does not accept if the replace throws", () => {
    const onDecide = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", insertedText: "clause" }],
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

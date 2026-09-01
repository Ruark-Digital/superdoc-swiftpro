import { describe, it, expect, vi } from "vitest";
import type { Editor } from "@harbour-enterprises/superdoc";
import {
  activeRedlineId,
  applyRedline,
  canMarkSelectedText,
  extractRedlines,
  focusRedline,
  markSelectedTextAsRedline,
  trackedChangeToSpan,
} from "./redlines";

/**
 * Build a minimal fake editor whose `doc` surface returns the given
 * tracked-change list items and records mutation calls.
 */
function fakeEditor(opts: {
  items?: unknown[];
  activeChangeIds?: string[];
  selection?: { empty?: boolean; target?: unknown; text?: string; activeChangeIds?: string[] };
  onReplace?: (input: unknown, options: unknown) => void;
  onDelete?: (input: unknown, options: unknown) => void;
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
    delete: (input: unknown, options: unknown) => opts.onDelete?.(input, options),
    selection: {
      current: () => opts.selection ?? ({ activeChangeIds: opts.activeChangeIds ?? [] }),
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

describe("markSelectedTextAsRedline", () => {
  // A realistic `selection.current()` target: a TextTarget (the read
  // projection), NOT the SelectionTarget the mutation ops require.
  const selection = {
    empty: false,
    target: { kind: "text", segments: [{ blockId: "b1", range: { start: 2, end: 15 } }] },
    text: "Selected text",
  };

  it("is available only for a plain text selection", () => {
    expect(canMarkSelectedText(fakeEditor({ selection }))).toBe(true);
    expect(canMarkSelectedText(fakeEditor({ selection: { empty: true, text: "" } }))).toBe(false);
    expect(canMarkSelectedText(fakeEditor({ selection: { ...selection, activeChangeIds: ["tc1"] } }))).toBe(false);
  });

  it("creates a tracked deletion, converting the TextTarget to a SelectionTarget", () => {
    const onDelete = vi.fn();
    expect(markSelectedTextAsRedline(fakeEditor({ selection, onDelete }))).toBe(true);
    // doc.delete must receive a SelectionTarget (start/end points), not the raw
    // TextTarget — passing the latter throws "target must be a SelectionTarget".
    expect(onDelete).toHaveBeenCalledWith(
      {
        target: {
          kind: "selection",
          start: { kind: "text", blockId: "b1", offset: 2 },
          end: { kind: "text", blockId: "b1", offset: 15 },
        },
      },
      { changeMode: "tracked" },
    );
  });

  it("spans multiple segments from first-start to last-end", () => {
    const onDelete = vi.fn();
    const multi = {
      empty: false,
      text: "across blocks",
      target: {
        kind: "text",
        segments: [
          { blockId: "b1", range: { start: 4, end: 9 } },
          { blockId: "b2", range: { start: 0, end: 7 } },
        ],
      },
    };
    expect(markSelectedTextAsRedline(fakeEditor({ selection: multi, onDelete }))).toBe(true);
    expect(onDelete).toHaveBeenCalledWith(
      {
        target: {
          kind: "selection",
          start: { kind: "text", blockId: "b1", offset: 4 },
          end: { kind: "text", blockId: "b2", offset: 7 },
        },
      },
      { changeMode: "tracked" },
    );
  });

  it("no-ops on a target with no usable segments", () => {
    const onDelete = vi.fn();
    const bad = { empty: false, text: "x", target: { kind: "text", segments: [] } };
    expect(markSelectedTextAsRedline(fakeEditor({ selection: bad, onDelete }))).toBe(false);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("keeps the selection plain when the editor is read-only", () => {
    const readOnly = { doc: { selection: { current: () => selection } }, isEditable: false } as unknown as Editor;
    expect(canMarkSelectedText(readOnly)).toBe(false);
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

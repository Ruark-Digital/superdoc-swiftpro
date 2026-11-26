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
  /** Result of `trackChanges.get`; omit to model a build without it. */
  getResult?: unknown;
}): Editor {
  const doc = {
    trackChanges: {
      list: () => {
        if (opts.listThrows) throw new Error("boom");
        return { items: opts.items ?? [] };
      },
      decide: (input: unknown) => opts.onDecide?.(input),
      ...(opts.getResult !== undefined ? { get: () => opts.getResult } : {}),
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

  it("keeps a replacement's deleted and inserted text separate", () => {
    expect(
      trackedChangeToSpan({
        id: "r1",
        type: "replacement",
        deletedText: "Senior",
        insertedText: "Principal",
        excerpt: "SeniorPrincipal",
      }),
    ).toMatchObject({ kind: "insertion", text: "Principal", deletedText: "Senior", insertedText: "Principal" });
    // insertedText missing: recover it from the concatenated excerpt.
    expect(
      trackedChangeToSpan({ id: "r2", type: "replacement", deletedText: "Senior", excerpt: "SeniorPrincipal" }),
    ).toMatchObject({ deletedText: "Senior", insertedText: "Principal" });
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

describe("applyRedline result", () => {
  it("reports ok when the swap was made", () => {
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", insertedText: "clause" }],
    });
    expect(applyRedline(editor, "tc1", "x")).toEqual({ ok: true });
  });
  it("reports why nothing changed (so the host never shows a no-op as resolved)", () => {
    expect(applyRedline(fakeEditor({ items: [] }), "gone", "x")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(
      applyRedline(fakeEditor({ items: [{ id: "t", type: "insert" }] }), "t", "x"),
    ).toEqual({ ok: false, reason: "no-text" });
    expect(
      applyRedline(
        fakeEditor({
          items: [{ id: "t", type: "insert", insertedText: "a" }],
          findResult: { items: [] },
        }),
        "t",
        "x",
      ),
    ).toEqual({ ok: false, reason: "no-target" });
    expect(applyRedline(null, "t", "x")).toEqual({ ok: false, reason: "no-editor" });
  });
});

describe("applyRedline", () => {
  it("does nothing when the id is not found", () => {
    const onReplace = vi.fn();
    applyRedline(fakeEditor({ items: [], onReplace }), "missing", "x");
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("resolves the tracked change FIRST (accept), then direct-replaces the plain text", () => {
    const calls: string[] = [];
    const onReplace = vi.fn(() => calls.push("replace"));
    const onDecide = vi.fn(() => calls.push("decide"));
    const onFind = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", insertedText: "the inserted clause" }],
      onFind,
      onReplace,
      onDecide,
    });
    expect(applyRedline(editor, "tc1", "new text")).toEqual({ ok: true });
    expect(onFind).toHaveBeenCalledWith({
      type: "text",
      pattern: "the inserted clause",
      caseSensitive: true,
    });
    expect(onDecide).toHaveBeenCalledWith({ decision: "accept", target: { id: "tc1" } });
    expect(onReplace).toHaveBeenCalledWith(
      { target: FAKE_TARGET, text: "new text" },
      { changeMode: "direct" },
    );
    expect(calls).toEqual(["decide", "replace"]);
  });

  it("rejects a deletion first (restoring its text), then replaces it", () => {
    const calls: string[] = [];
    const editor = fakeEditor({
      items: [{ id: "d1", type: "delete", deletedText: "old clause" }],
      onDecide: (i) => calls.push(JSON.stringify(i)),
      onReplace: () => calls.push("replace"),
    });
    expect(applyRedline(editor, "d1", "new")).toEqual({ ok: true });
    expect(calls).toEqual([JSON.stringify({ decision: "reject", target: { id: "d1" } }), "replace"]);
  });

  it("replaces the INSERTED half of a replacement, not the concatenated excerpt", () => {
    const onFind = vi.fn();
    applyRedline(
      fakeEditor({
        items: [
          { id: "r1", type: "replacement", deletedText: "Senior", insertedText: "Principal", excerpt: "SeniorPrincipal" },
        ],
        onFind,
      }),
      "r1",
      "Lead",
    );
    expect(onFind).toHaveBeenCalledWith(expect.objectContaining({ pattern: "Principal" }));
  });

  it("does not touch the document when the text cannot be located", () => {
    const onReplace = vi.fn();
    const onDecide = vi.fn();
    const result = applyRedline(
      fakeEditor({
        items: [{ id: "tc1", type: "insert", insertedText: "x" }],
        findResult: { items: [] },
        onReplace,
        onDecide,
      }),
      "tc1",
      "y",
    );
    expect(result).toEqual({ ok: false, reason: "no-target" });
    expect(onReplace).not.toHaveBeenCalled();
    expect(onDecide).not.toHaveBeenCalled();
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

  it("reports resolve-failed and does not replace when the change cannot be resolved", () => {
    const onReplace = vi.fn();
    const editor = fakeEditor({
      items: [{ id: "tc1", type: "insert", insertedText: "clause" }],
      onDecide: () => {
        throw new Error("nope");
      },
      onReplace,
    });
    expect(applyRedline(editor, "tc1", "x")).toEqual({ ok: false, reason: "resolve-failed" });
    expect(onReplace).not.toHaveBeenCalled();
  });
});

/**
 * A tiny model of SuperDoc's review-state protection: a direct edit that touches
 * text still inside a tracked change is force-tracked (struck deletion + tracked
 * insertion), exactly as `#dispatchTransaction` does. This is what made the old
 * replace-then-accept order leave "Lag~~Auckland~~STUBos".
 */
describe("applyRedline against the review-state protection rule", () => {
  type Seg = { text: string; tracked?: { id: string; type: "insert" | "delete" } };

  function modelEditor(initial: Seg[]) {
    let segs: Seg[] = initial.map((s) => ({ ...s }));
    const doc = {
      trackChanges: {
        list: () => ({
          items: segs
            .filter((s) => s.tracked)
            .map((s) => ({
              id: s.tracked!.id,
              type: s.tracked!.type,
              insertedText: s.tracked!.type === "insert" ? s.text : undefined,
              deletedText: s.tracked!.type === "delete" ? s.text : undefined,
            })),
        }),
        decide: ({ decision, target }: { decision: string; target: { id: string } }) => {
          segs = segs.flatMap((s) => {
            if (s.tracked?.id !== target.id) return [s];
            const keep =
              (s.tracked.type === "insert" && decision === "accept") ||
              (s.tracked.type === "delete" && decision === "reject");
            return keep ? [{ text: s.text }] : [];
          });
        },
      },
      query: {
        match: ({ pattern }: { pattern: string }) => {
          const i = segs.findIndex((s) => s.text === pattern);
          return i < 0 ? { items: [] } : { items: [{ target: { seg: i } }] };
        },
      },
      replace: ({ target, text }: { target: { seg: number }; text: string }) => {
        const seg = segs[target.seg];
        if (seg.tracked) {
          // Protected review state: becomes tracked deletion + tracked insertion.
          segs.splice(target.seg, 1, { ...seg, tracked: { id: seg.tracked.id, type: "delete" } }, {
            text,
            tracked: { id: "new", type: "insert" },
          });
        } else {
          seg.text = text;
        }
      },
      selection: { current: () => ({}) },
    };
    return { editor: { doc } as unknown as Editor, segs: () => segs };
  }

  it("ends with only the approved text and no tracked marks for the applied suggestion", () => {
    const { editor, segs } = modelEditor([
      { text: "Lag" },
      { text: "Auckland", tracked: { id: "t1", type: "insert" } },
      { text: "os" },
    ]);
    expect(applyRedline(editor, "t1", "STUB")).toEqual({ ok: true });
    expect(segs().map((s) => s.text).join("")).toBe("LagSTUBos");
    expect(segs().some((s) => s.tracked)).toBe(false);
  });

  it("a replacement pair keeps only the approved text (no struck original)", () => {
    const { editor, segs } = modelEditor([
      { text: "Senior", tracked: { id: "t2", type: "delete" } },
      { text: "Principal", tracked: { id: "t2", type: "insert" } },
    ]);
    // Both halves share an id in SuperDoc; model resolves by id.
    expect(applyRedline(editor, "t2", "Lead")).toEqual({ ok: true });
    expect(segs().map((s) => s.text).join("")).toBe("Lead");
    expect(segs().some((s) => s.tracked)).toBe(false);
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

describe("replacement whose list item has only a glued excerpt", () => {
  const glued = { id: "r1", type: "replacement", excerpt: "RemoOnsi" };

  it("reads both halves from trackChanges.get and applies cleanly", () => {
    const onFind = vi.fn();
    const onReplace = vi.fn();
    const editor = fakeEditor({
      items: [glued],
      getResult: { id: "r1", type: "replacement", deletedText: "Remote", insertedText: "Onsite" },
      onFind,
      onReplace,
    });
    expect(applyRedline(editor, "r1", "Hybrid")).toEqual({ ok: true });
    expect(onFind).toHaveBeenCalledWith(expect.objectContaining({ pattern: "Onsite" }));
    expect(onReplace).toHaveBeenCalled();
    expect(extractRedlines(editor)[0]).toMatchObject({
      deletedText: "Remote",
      insertedText: "Onsite",
    });
  });

  it("never searches the glued excerpt; reports no-text and leaves the document alone", () => {
    const onFind = vi.fn();
    const onDecide = vi.fn();
    const result = applyRedline(fakeEditor({ items: [glued], onFind, onDecide }), "r1", "x");
    expect(result).toEqual({ ok: false, reason: "no-text" });
    expect(onFind).not.toHaveBeenCalled();
    expect(onDecide).not.toHaveBeenCalled();
  });
});

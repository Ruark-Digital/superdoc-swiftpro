import { describe, expect, it, vi } from "vitest";
import type { Editor, SuperDoc } from "@harbour-enterprises/superdoc";
import { captureSelection, createAnchoredComment, focusComment } from "./comments";

const editorWithDoc = (doc: unknown): Editor => ({ doc } as unknown as Editor);

describe("captureSelection", () => {
  it("returns target + trimmed excerpt for a non-empty selection", () => {
    const editor = editorWithDoc({
      selection: {
        current: () => ({ empty: false, target: { segments: [1] }, text: "  quoted  " }),
      },
    });
    expect(captureSelection(editor)).toEqual({ target: { segments: [1] }, excerpt: "quoted" });
  });

  it("returns null for an empty selection, a null target, or a throwing API", () => {
    expect(
      captureSelection(editorWithDoc({ selection: { current: () => ({ empty: true, target: null }) } })),
    ).toBeNull();
    expect(
      captureSelection(editorWithDoc({ selection: { current: () => ({ empty: false, target: null }) } })),
    ).toBeNull();
    expect(
      captureSelection(editorWithDoc({ selection: { current: () => { throw new Error("boom"); } } })),
    ).toBeNull();
    expect(captureSelection(null)).toBeNull();
  });

  it("caps the excerpt at 80 chars", () => {
    const long = "x".repeat(200);
    const editor = editorWithDoc({
      selection: { current: () => ({ empty: false, target: {}, text: long }) },
    });
    expect(captureSelection(editor)?.excerpt).toHaveLength(80);
  });
});

describe("createAnchoredComment", () => {
  it("creates a comment at the target and returns the receipt id", () => {
    const create = vi.fn().mockReturnValue({ id: "c1" });
    const editor = editorWithDoc({ comments: { create } });
    expect(createAnchoredComment(editor, "note", { t: 1 })).toBe("c1");
    expect(create).toHaveBeenCalledWith({ text: "note", target: { t: 1 } });
  });

  it("returns null on failure receipt, missing target, empty text, or API throw", () => {
    const editor = editorWithDoc({ comments: { create: () => ({ ok: false }) } });
    expect(createAnchoredComment(editor, "note", { t: 1 })).toBeNull();
    expect(createAnchoredComment(editor, "note", null)).toBeNull();
    expect(createAnchoredComment(editor, "", { t: 1 })).toBeNull();
    const throwing = editorWithDoc({ comments: { create: () => { throw new Error("boom"); } } });
    expect(createAnchoredComment(throwing, "note", { t: 1 })).toBeNull();
    expect(createAnchoredComment(null, "note", { t: 1 })).toBeNull();
  });
});

describe("focusComment", () => {
  it("navigates to the comment entity", () => {
    const navigateTo = vi.fn().mockResolvedValue(undefined);
    focusComment({ navigateTo } as unknown as SuperDoc, "c1");
    expect(navigateTo).toHaveBeenCalledWith({ kind: "entity", entityType: "comment", entityId: "c1" });
  });

  it("no-ops on missing instance, empty id, or navigateTo throw", () => {
    expect(() => focusComment(null, "c1")).not.toThrow();
    expect(() => focusComment({} as unknown as SuperDoc, "c1")).not.toThrow();
    const navigateTo = vi.fn(() => { throw new Error("boom"); });
    expect(() => focusComment({ navigateTo } as unknown as SuperDoc, "")).not.toThrow();
    expect(navigateTo).not.toHaveBeenCalled();
    expect(() => focusComment({ navigateTo } as unknown as SuperDoc, "c1")).not.toThrow();
  });
});

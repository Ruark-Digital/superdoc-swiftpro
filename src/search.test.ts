import { describe, it, expect, vi } from "vitest";
import {
  clearSearch,
  formatMatchLabel,
  isFindShortcut,
  runSearch,
  stepMatch,
  type SearchEditor,
} from "./search";

/** Minimal fake editor exposing the SuperDoc search commands. */
function fakeEditor(opts: {
  matches?: unknown[];
  activeMatchIndex?: number;
  next?: number;
  prev?: number;
  throwOnSet?: boolean;
  onSet?: (q: string, o: unknown) => void;
  onClear?: () => void;
}): SearchEditor {
  return {
    commands: {
      setSearchSession: (q, o) => {
        opts.onSet?.(q, o);
        if (opts.throwOnSet) throw new Error("boom");
        return {
          matches: opts.matches ?? [],
          activeMatchIndex: opts.activeMatchIndex ?? 0,
        };
      },
      clearSearchSession: () => opts.onClear?.(),
      nextSearchMatch: () => ({ activeMatchIndex: opts.next ?? 0 }),
      previousSearchMatch: () => ({ activeMatchIndex: opts.prev ?? 0 }),
    },
  };
}

describe("runSearch", () => {
  it("returns match count + active index and requests highlighting", () => {
    const onSet = vi.fn();
    const editor = fakeEditor({
      matches: [1, 2, 3],
      activeMatchIndex: 0,
      onSet,
    });
    expect(runSearch(editor, "clause")).toEqual({ count: 3, index: 0 });
    expect(onSet).toHaveBeenCalledWith(
      "clause",
      expect.objectContaining({ highlight: true, searchModel: "visible" }),
    );
  });

  it("clears the session and returns empty for a blank query", () => {
    const onClear = vi.fn();
    const editor = fakeEditor({ onClear });
    expect(runSearch(editor, "")).toEqual({ count: 0, index: -1 });
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("degrades to empty when the editor / commands are missing", () => {
    expect(runSearch(null, "x")).toEqual({ count: 0, index: -1 });
    expect(runSearch({ commands: {} }, "x")).toEqual({ count: 0, index: -1 });
  });

  it("swallows a SuperDoc throw", () => {
    expect(runSearch(fakeEditor({ throwOnSet: true }), "x")).toEqual({
      count: 0,
      index: -1,
    });
  });

  it("passes caseSensitive through", () => {
    const onSet = vi.fn();
    runSearch(fakeEditor({ onSet }), "X", { caseSensitive: true });
    expect(onSet).toHaveBeenCalledWith(
      "X",
      expect.objectContaining({ caseSensitive: true }),
    );
  });
});

describe("stepMatch", () => {
  it("returns the new active index for next/prev", () => {
    const editor = fakeEditor({ next: 2, prev: 1 });
    expect(stepMatch(editor, "next")).toBe(2);
    expect(stepMatch(editor, "prev")).toBe(1);
  });

  it("returns -1 when commands are missing", () => {
    expect(stepMatch(null, "next")).toBe(-1);
    expect(stepMatch({ commands: {} }, "prev")).toBe(-1);
  });
});

describe("clearSearch", () => {
  it("never throws on a null editor", () => {
    expect(() => clearSearch(null)).not.toThrow();
  });
});

describe("formatMatchLabel", () => {
  it("empty for no query", () => {
    expect(formatMatchLabel("", 0, -1)).toBe("");
  });
  it("'No results' for a query with zero hits", () => {
    expect(formatMatchLabel("zzz", 0, -1)).toBe("No results");
  });
  it("'N of M' (1-based) otherwise", () => {
    expect(formatMatchLabel("clause", 11, 0)).toBe("1 of 11");
    expect(formatMatchLabel("clause", 11, 5)).toBe("6 of 11");
  });
});

describe("isFindShortcut", () => {
  const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;
  it("matches Ctrl+F and Cmd+F", () => {
    expect(isFindShortcut(ev({ ctrlKey: true, key: "f" }))).toBe(true);
    expect(isFindShortcut(ev({ metaKey: true, key: "F" }))).toBe(true);
  });
  it("ignores plain F and Ctrl+Alt+F", () => {
    expect(isFindShortcut(ev({ key: "f" }))).toBe(false);
    expect(isFindShortcut(ev({ ctrlKey: true, altKey: true, key: "f" }))).toBe(false);
  });
});

/**
 * applyRedline against a REAL (headless) SuperDoc editor, not a fake doc API.
 *
 * N9 flow: the CM suggests "Remote" -> "Hybrid" (a tracked replacement), the PM
 * approves an AI alternative, and the CM's Approve & apply must leave exactly
 * the approved text, with no tracked change left over.
 */
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@harbour-enterprises/superdoc";
import * as SE from "@harbour-enterprises/superdoc/super-editor";
import { applyRedline } from "./redlines";

type RealDoc = {
  insert: (i: { value: string }) => unknown;
  getText: (i: object) => string;
  query: { match: (s: object) => { items: Array<{ target: unknown }> } };
  replace: (i: object, o?: object) => unknown;
  trackChanges: { list: (i: object) => { items: Array<{ id: string }> } };
};

async function cmEditorWithSuggestion() {
  const se = SE as unknown as Record<string, any>;
  const buf = Buffer.from(se.BLANK_DOCX_BASE64, "base64");
  const [content, media, mediaFiles, fonts] = await se.Editor.loadXmlData(buf, true);
  const editor = new se.Editor({
    isHeadless: true,
    mode: "docx",
    documentId: "n9",
    extensions: se.getStarterExtensions(),
    content,
    media,
    mediaFiles,
    fonts,
    telemetry: { enabled: false },
    user: { name: "CM", email: "cm@x" },
  });
  const doc = editor.doc as RealDoc;
  doc.insert({ value: "Work is Remote today." });
  const remote = doc.query.match({ type: "text", pattern: "Remote", caseSensitive: true });
  doc.replace({ target: remote.items[0].target, text: "Hybrid" }, { changeMode: "tracked" });
  const [change] = doc.trackChanges.list({ in: "all" }).items;
  return { editor: editor as Editor, doc, id: change.id };
}

describe("applyRedline on a real editor (N9)", () => {
  it("puts the approved alternative in place when the direct replace throws after accept", async () => {
    const { editor, doc, id } = await cmEditorWithSuggestion();
    expect(doc.getText({}).trim()).toBe("Work is RemoteHybrid today.");
    // The live CM editor's direct replace of the just-accepted text throws
    // (QA run 2: redline-applied {ok:false, reason:"replace-failed"}).
    const original = doc.replace.bind(doc);
    const replace = vi.fn((input: object, options?: { changeMode?: string }) => {
      if (options?.changeMode === "direct") throw new Error("TARGET_NOT_FOUND: stale target");
      return original(input, options);
    });
    doc.replace = replace;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = applyRedline(editor, id, "STUB medium alt.");

    expect(replace).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
    expect(doc.getText({}).trim()).toBe("Work is STUB medium alt. today.");
    expect(doc.trackChanges.list({ in: "all" }).items).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      "[redlines] apply",
      expect.objectContaining({ id, outcome: "applied-via-state", replaceError: "Error: TARGET_NOT_FOUND: stale target" }),
    );
    info.mockRestore();
  });

  it("accepts only, with no replace, when the approved text is the suggestion itself", async () => {
    const { editor, doc, id } = await cmEditorWithSuggestion();
    const original = doc.replace.bind(doc);
    const replace = vi.fn((input: object, options?: object) => original(input, options));
    doc.replace = replace;
    vi.spyOn(console, "info").mockImplementation(() => {});

    expect(applyRedline(editor, id, "Hybrid")).toEqual({ ok: true });
    expect(replace).not.toHaveBeenCalled();
    expect(doc.getText({}).trim()).toBe("Work is Hybrid today.");
    expect(doc.trackChanges.list({ in: "all" }).items).toHaveLength(0);
  });

  it("applies the approved alternative on the normal path", async () => {
    const { editor, doc, id } = await cmEditorWithSuggestion();
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(applyRedline(editor, id, "STUB medium alt.")).toEqual({ ok: true });
    expect(doc.getText({}).trim()).toBe("Work is STUB medium alt. today.");
    expect(doc.trackChanges.list({ in: "all" }).items).toHaveLength(0);
  });
});

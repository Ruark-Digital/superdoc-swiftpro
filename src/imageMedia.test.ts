import { describe, it, expect } from "vitest";
import {
  mergeLocalMedia,
  resolveMediaForSrc,
  repaintBrokenImages,
  hydrateImageMedia,
  type ImageElementLike,
} from "./imageMedia";

const DATA_URI = "data:image/png;base64,AAAA";
const DATA_URI_2 = "data:image/png;base64,BBBB";

/** Minimal stand-in for an <img> element (node test env has no DOM). */
function fakeImg(initialSrc: string): ImageElementLike & { src: string } {
  let value = initialSrc;
  return {
    getAttribute: () => value,
    setAttribute: (_name: string, next: string) => {
      value = next;
    },
    get src() {
      return value;
    },
  };
}

describe("mergeLocalMedia", () => {
  it("fills only the keys missing from the store and reports the count", () => {
    const store: Record<string, string> = { "word/media/image1.png": DATA_URI };
    const filled = mergeLocalMedia(
      { "word/media/image1.png": DATA_URI_2, "word/media/image2.png": DATA_URI_2 },
      store,
    );
    expect(filled).toBe(1); // image1 already present (not overwritten); image2 added
    expect(store["word/media/image1.png"]).toBe(DATA_URI); // existing value kept
    expect(store["word/media/image2.png"]).toBe(DATA_URI_2);
  });

  it("ignores non-string and empty values, and a missing local map", () => {
    const store: Record<string, string> = {};
    expect(
      mergeLocalMedia(
        { a: "", b: undefined as unknown as string, c: 42 as unknown as string },
        store,
      ),
    ).toBe(0);
    expect(mergeLocalMedia(undefined, store)).toBe(0);
    expect(Object.keys(store)).toHaveLength(0);
  });
});

describe("resolveMediaForSrc", () => {
  const media = { "word/media/image109.png": DATA_URI, "word/media/image1.png": DATA_URI_2 };

  it("returns null for an already-resolved data URI", () => {
    expect(resolveMediaForSrc(DATA_URI, media)).toBeNull();
  });

  it("resolves an exact relative media-path key", () => {
    expect(resolveMediaForSrc("word/media/image109.png", media)).toBe(DATA_URI);
  });

  it("resolves an origin-resolved absolute URL by its trailing key", () => {
    expect(
      resolveMediaForSrc("https://editor.swiftpro.tech/word/media/image109.png", media),
    ).toBe(DATA_URI);
  });

  it("does not let a shorter key falsely match a longer filename", () => {
    // image1.png must NOT match …/image109.png
    expect(
      resolveMediaForSrc("https://editor.swiftpro.tech/word/media/image109.png", media),
    ).toBe(DATA_URI);
  });

  it("returns null when nothing matches", () => {
    expect(resolveMediaForSrc("word/media/nope.png", media)).toBeNull();
  });
});

describe("repaintBrokenImages", () => {
  it("rewrites a broken key src to the resolved data URI", () => {
    const img = fakeImg("word/media/image109.png");
    const n = repaintBrokenImages([img], { "word/media/image109.png": DATA_URI });
    expect(n).toBe(1);
    expect(img.src).toBe(DATA_URI);
  });

  it("leaves already-resolved and unmatched images untouched", () => {
    const resolved = fakeImg(DATA_URI);
    const unknown = fakeImg("word/media/ghost.png");
    const n = repaintBrokenImages([resolved, unknown], { "word/media/image1.png": DATA_URI_2 });
    expect(n).toBe(0);
    expect(resolved.src).toBe(DATA_URI);
    expect(unknown.src).toBe("word/media/ghost.png");
  });
});

describe("hydrateImageMedia", () => {
  it("back-fills the join-path media map AND repaints the broken images", () => {
    const broken = fakeImg("word/media/image109.png");
    const editor = {
      options: { mediaFiles: { "word/media/image109.png": DATA_URI } },
      storage: { image: { media: {} as Record<string, string> } }, // join: empty Yjs media map
      view: { dom: { querySelectorAll: (_: string) => [broken] } },
    };

    hydrateImageMedia(editor);

    expect(editor.storage.image.media["word/media/image109.png"]).toBe(DATA_URI);
    expect(broken.src).toBe(DATA_URI);
  });

  it("is a no-op on the seed path (store already populated, images resolved)", () => {
    const resolved = fakeImg(DATA_URI);
    const media = { "word/media/image1.png": DATA_URI };
    const editor = {
      options: { mediaFiles: { "word/media/image1.png": DATA_URI } },
      storage: { image: { media } },
      view: { dom: { querySelectorAll: (_: string) => [resolved] } },
    };

    hydrateImageMedia(editor);

    expect(editor.storage.image.media).toEqual({ "word/media/image1.png": DATA_URI });
    expect(resolved.src).toBe(DATA_URI);
  });

  it("does nothing when the image extension storage is absent", () => {
    expect(() => hydrateImageMedia({ options: { mediaFiles: {} } })).not.toThrow();
    expect(() => hydrateImageMedia(null)).not.toThrow();
  });
});

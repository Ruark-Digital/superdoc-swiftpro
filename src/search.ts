/**
 * In-editor find bar (Ctrl/Cmd-F) — QA #231.
 *
 * SwiftPro's redline reviewers asked for MS-Word-style find on the redlined
 * document: type a term, see "N of M", and step through matches with the
 * arrows. The browser's native find is unreliable over SuperDoc's paginated
 * DOM, so we intercept Ctrl/Cmd-F and drive SuperDoc's own search commands
 * instead — highlighting and scroll-into-view are handled by SuperDoc.
 *
 * This lives entirely inside the iframe (the key is pressed while focus is in
 * this app) — no postMessage/host involvement.
 *
 * SuperDoc search API (present in the installed v1.38 runtime but NOT in the
 * shipped .d.ts, so typed structurally + guarded — same defensive contract as
 * redlines.ts / comments.ts):
 *   editor.commands.setSearchSession(query, {
 *     caseSensitive, ignoreDiacritics, highlight, searchModel
 *   }) → { matches: unknown[]; activeMatchIndex: number }
 *   editor.commands.clearSearchSession(): void
 *   editor.commands.nextSearchMatch(): { activeMatchIndex: number }
 *   editor.commands.previousSearchMatch(): { activeMatchIndex: number }
 */

interface SearchSessionResult {
  matches?: unknown[];
  activeMatchIndex?: number;
}

interface SearchCommands {
  setSearchSession: (
    query: string,
    opts: {
      caseSensitive?: boolean;
      ignoreDiacritics?: boolean;
      highlight?: boolean;
      searchModel?: string;
    },
  ) => SearchSessionResult | undefined;
  clearSearchSession: () => void;
  nextSearchMatch: () => SearchSessionResult | undefined;
  previousSearchMatch: () => SearchSessionResult | undefined;
}

/** Structural view of the editor — only the search commands we call. */
export interface SearchEditor {
  commands?: Partial<SearchCommands>;
}

export interface SearchResult {
  /** Total matches in the document. */
  count: number;
  /** 0-based index of the active match, or -1 when there are none. */
  index: number;
}

const EMPTY: SearchResult = { count: 0, index: -1 };

/**
 * Start/replace a search session for `query`. An empty query clears the
 * session. Always returns a {@link SearchResult}; never throws (a SuperDoc API
 * throw degrades to "no matches").
 */
export function runSearch(
  editor: SearchEditor | null,
  query: string,
  opts?: { caseSensitive?: boolean },
): SearchResult {
  const q = typeof query === "string" ? query : "";
  if (q.length === 0) {
    clearSearch(editor);
    return EMPTY;
  }
  const setSearchSession = editor?.commands?.setSearchSession;
  if (typeof setSearchSession !== "function") return EMPTY;
  try {
    const result = setSearchSession(q, {
      caseSensitive: opts?.caseSensitive ?? false,
      ignoreDiacritics: true,
      highlight: true,
      // Match SuperDoc's own search dialog default.
      searchModel: "visible",
    });
    const count = Array.isArray(result?.matches) ? result!.matches!.length : 0;
    const index =
      typeof result?.activeMatchIndex === "number"
        ? result!.activeMatchIndex!
        : count > 0
          ? 0
          : -1;
    return { count, index };
  } catch {
    return EMPTY;
  }
}

/** Clear the active search session (removes highlights). Never throws. */
export function clearSearch(editor: SearchEditor | null): void {
  try {
    editor?.commands?.clearSearchSession?.();
  } catch {
    // no-op
  }
}

/**
 * Step to the next/previous match; returns the new 0-based active index (-1 if
 * unavailable). Wrapping is SuperDoc's behaviour.
 */
export function stepMatch(
  editor: SearchEditor | null,
  direction: "next" | "prev",
): number {
  const cmd =
    direction === "next"
      ? editor?.commands?.nextSearchMatch
      : editor?.commands?.previousSearchMatch;
  if (typeof cmd !== "function") return -1;
  try {
    const result = cmd();
    return typeof result?.activeMatchIndex === "number"
      ? result.activeMatchIndex
      : -1;
  } catch {
    return -1;
  }
}

/**
 * Human-readable match counter, MS-Word style. `index` is 0-based.
 *   - no query      → ""
 *   - query, 0 hits → "No results"
 *   - otherwise     → "3 of 11"
 */
export function formatMatchLabel(
  query: string,
  count: number,
  index: number,
): string {
  if (!query) return "";
  if (count <= 0) return "No results";
  const current = index >= 0 ? index + 1 : 1;
  return `${current} of ${count}`;
}

/** True for a Ctrl-F (or ⌘-F on macOS) keydown. */
export function isFindShortcut(event: KeyboardEvent): boolean {
  return Boolean(
    (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key?.toLowerCase() === "f",
  );
}

const SEARCH_DEBOUNCE_MS = 150;

/**
 * Build the find bar, wire Ctrl/Cmd-F, and return a teardown function.
 *
 * `getEditor` is a getter (not the editor itself) so the bar keeps working
 * across the SuperDoc lifecycle — main.ts may set/replace the editor after this
 * runs.
 */
export function installFindBar(getEditor: () => SearchEditor | null): () => void {
  const doc = document;

  const bar = doc.createElement("div");
  bar.className = "find-bar";
  bar.hidden = true;
  bar.setAttribute("role", "search");

  const input = doc.createElement("input");
  input.type = "text";
  input.className = "find-bar__input";
  input.placeholder = "Find in document";
  input.setAttribute("aria-label", "Find in document");

  const count = doc.createElement("span");
  count.className = "find-bar__count";
  count.setAttribute("aria-live", "polite");

  const prev = doc.createElement("button");
  prev.type = "button";
  prev.className = "find-bar__btn";
  prev.title = "Previous match (Shift+Enter)";
  prev.setAttribute("aria-label", "Previous match");
  prev.textContent = "↑"; // ↑

  const next = doc.createElement("button");
  next.type = "button";
  next.className = "find-bar__btn";
  next.title = "Next match (Enter)";
  next.setAttribute("aria-label", "Next match");
  next.textContent = "↓"; // ↓

  const close = doc.createElement("button");
  close.type = "button";
  close.className = "find-bar__btn find-bar__close";
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close find bar");
  close.textContent = "×"; // ×

  bar.append(input, count, prev, next, close);
  doc.body.appendChild(bar);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCount = 0;

  const render = (index: number): void => {
    count.textContent = formatMatchLabel(input.value, lastCount, index);
    const disabled = lastCount <= 0;
    prev.disabled = disabled;
    next.disabled = disabled;
  };

  const search = (): void => {
    const { count: c, index } = runSearch(getEditor(), input.value);
    lastCount = c;
    render(index);
  };

  const scheduleSearch = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(search, SEARCH_DEBOUNCE_MS);
  };

  const step = (direction: "next" | "prev"): void => {
    if (lastCount <= 0) return;
    render(stepMatch(getEditor(), direction));
  };

  const open = (): void => {
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value) search();
  };

  const hide = (): void => {
    bar.hidden = true;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    clearSearch(getEditor());
    lastCount = 0;
  };

  input.addEventListener("input", scheduleSearch);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? "prev" : "next");
    } else if (event.key === "Escape") {
      event.preventDefault();
      hide();
    }
  });
  prev.addEventListener("click", () => step("prev"));
  next.addEventListener("click", () => step("next"));
  close.addEventListener("click", hide);

  const onKeydown = (event: KeyboardEvent): void => {
    if (!isFindShortcut(event)) return;
    // Replace the browser's native find, which does not work over SuperDoc's
    // paginated document, with our SuperDoc-backed find bar.
    event.preventDefault();
    open();
  };
  window.addEventListener("keydown", onKeydown);

  return () => {
    window.removeEventListener("keydown", onKeydown);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    clearSearch(getEditor());
    bar.remove();
  };
}

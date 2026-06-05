# Build Plan — `superdoc-swiftpro` (AGPL SuperDoc iframe app)

> **Read this first.** This repo is the **AGPL-3.0 half** of a deliberately split
> feature. The proprietary SwiftPro app (repo `swifter`) embeds this app in a
> cross-origin `<iframe>` and talks to it **only** via `postMessage`. That
> arms-length boundary is what keeps SuperDoc's AGPL copyleft *out* of SwiftPro's
> proprietary bundle. **Do not** try to import SuperDoc into SwiftPro — the whole
> point is that it lives here, behind an iframe.

## Status

- The **host side is already built and merged-ready** in `swifter` on branch
  `feat-collab-superdoc-editor`. It renders this app's iframe when the
  CollaborationToolPage URL has `?editor=superdoc`.
- **This repo is empty.** Your job: build the SuperDoc app that satisfies the
  postMessage contract below, connect it to the same Yjs collab server, and
  deploy it to its own origin.

## Why this exists (context)

SwiftPro needs Google-Docs-quality `.docx` rendering/editing in its
CollaborationToolPage. The custom TipTap editor couldn't reach the fidelity bar.
SuperDoc (`@harbour-enterprises/superdoc`, v1.38.0, **AGPL-3.0**) renders OOXML
faithfully, but AGPL would force SwiftPro's proprietary code open if imported
directly. The user has **no commercial license**, so we isolate SuperDoc in this
separate AGPL app and bridge via `postMessage`.

Full design rationale lives in the host repo (read if you have access):
- `swifter/docs/superpowers/specs/2026-06-05-superdoc-iframe-editor-design.md`
- `swifter/docs/superpowers/plans/2026-06-05-superdoc-iframe-editor.md`
- Host bridge source (the contract's other side):
  - `swifter/src/pages/CollaborationToolPage/collab/superdocBridge.ts`
  - `swifter/src/pages/CollaborationToolPage/components/IframeEditorPane.tsx`

## Architecture

```
┌──────────── swifter (proprietary) ────────────┐
│  IframeEditorPane.tsx                          │
│   • <iframe src={VITE_SUPERDOC_APP_URL}>       │
│   • fetches the .docx → sends bytes            │
│   • origin-checks every message                │
└───────────────│ postMessage │─────────────────┘
                ▼            ▲
┌──────────── THIS REPO: superdoc-swiftpro (AGPL-3.0) ──────────┐
│  Vite app                                                     │
│   • on load → postMessage `superdoc:ready` to host           │
│   • on `superdoc:init` → Blob(docBytes) → new SuperDoc({...}) │
│   • y-websocket provider → wsUrl, room = payload.roomId       │
│   • posts `superdoc:editor-ready` / `doc-edit` / `error`      │
└───────────────────────────────────────────────────────────────┘
```

## THE CONTRACT (must match the host exactly)

Messages are plain objects `{ type, payload? }`. Both sides do strict
`event.origin` checks. **The host's origin** is configured here as
`VITE_HOST_ORIGIN`; **this app's origin** is configured in the host as
`VITE_SUPERDOC_APP_URL`. They must point at each other.

### Host → this app

| `type` | `payload` |
|---|---|
| `superdoc:init` | `{ docBytes: ArrayBuffer, fileName: string, fileType: string, documentMode: "editing"\|"viewing"\|"suggesting", user: { name: string, email: string }, roomId: string, wsUrl: string }` |

`docBytes` arrives as a **transferable** `ArrayBuffer` (the host fetched the
`.docx` so this app needs no auth/CORS). `documentMode` defaults to `"editing"`.

> ⚠️ **GOTCHA:** `payload.roomId` is **already namespaced** by the host —
> it is `<baseRoom>:superdoc` (the host's `buildInitPayload` appends `:superdoc`).
> Use `payload.roomId` **verbatim** as the y-websocket room. Do **NOT** append
> `:superdoc` again, and do **NOT** strip it.

### This app → host

| `type` | `payload` | When |
|---|---|---|
| `superdoc:ready` | — | On app load, once, before anything else. Signals "send me `init`". |
| `superdoc:editor-ready` | `{ pageCount?: number }` | After SuperDoc finishes loading the document. |
| `superdoc:doc-edit` | — | On each document change (host uses it for a version-timeline ping). Debounce ~1s. |
| `superdoc:error` | `{ message: string }` | On any init/load failure. |

The host **drops** any `editor-ready.pageCount` that isn't a number, and
defaults a missing `error.message` to `"Unknown error"` — so send clean shapes.

### Origin handling (security — get this right)

- **Outbound:** `window.parent.postMessage(msg, VITE_HOST_ORIGIN)`. Never use
  `"*"` once you know the host origin. (For the very first `superdoc:ready`, post
  to `VITE_HOST_ORIGIN` — you already know it from env, so no `"*"` is needed.)
- **Inbound:** ignore any `event` whose `event.origin !== VITE_HOST_ORIGIN`.
- The host validates that *our* messages come from `VITE_SUPERDOC_APP_URL`'s
  origin — which is automatic since we run on that origin.

### Copyable type definitions (mirror of the host's `superdocBridge.ts`)

```ts
export type DocumentMode = "editing" | "viewing" | "suggesting";

// received from host
export type SuperdocInit = {
  type: "superdoc:init";
  payload: {
    docBytes: ArrayBuffer;
    fileName: string;
    fileType: string;
    documentMode: DocumentMode;
    user: { name: string; email: string };
    roomId: string;   // ALREADY ends in ":superdoc" — use verbatim
    wsUrl: string;
  };
};

// sent to host
export type SuperdocOutbound =
  | { type: "superdoc:ready" }
  | { type: "superdoc:editor-ready"; payload: { pageCount?: number } }
  | { type: "superdoc:doc-edit" }
  | { type: "superdoc:error"; payload: { message: string } };
```

## SuperDoc API (grounded from docs.superdoc.dev, 2026-06-05)

```ts
import { SuperDoc } from "@harbour-enterprises/superdoc"; // VERIFY specifier (see risks)
import "@harbour-enterprises/superdoc/style.css";

const superdoc = new SuperDoc({
  selector: "#editor",
  document: blob,                 // URL | File | Blob — we use a Blob built from docBytes
  documentMode: payload.documentMode,
  user: payload.user,             // { name, email }
  modules: {
    collaboration: { ydoc, provider },   // provider-agnostic Yjs
  },
});
```

Build the document blob from the transferred bytes:

```ts
const blob = new Blob([payload.docBytes], {
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});
```

Yjs collaboration (same server as SwiftPro):

```ts
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const ydoc = new Y.Doc();
const provider = new WebsocketProvider(payload.wsUrl, payload.roomId, ydoc);
```

## Task breakdown (suggested, TDD where it pays off)

1. **Scaffold:** `pnpm create vite superdoc-swiftpro --template react-ts` (or
   vanilla-ts — SuperDoc is framework-agnostic; React is fine). Add
   `@harbour-enterprises/superdoc`, `yjs`, `y-websocket`. Commit.
2. **Add AGPL LICENSE** (`AGPL-3.0`) at repo root + a `README` stating this is
   the AGPL companion to SwiftPro and where source is published. Commit.
3. **Bridge module** (`src/bridge.ts`): the message types above + a
   `parseHostMessage(event, hostOrigin)` (origin-check + shape validation,
   mirror of the host's `parseSuperdocMessage`) + a typed `postToHost(msg)`.
   Unit-test it (origin reject, shape validation). Commit.
4. **Boot + handshake** (`src/main.ts(x)`): on load `postToHost({type:"superdoc:ready"})`;
   on `superdoc:init` build the Blob, create `ydoc`+`provider`, `new SuperDoc(...)`.
   Post `superdoc:editor-ready` when SuperDoc signals ready; `superdoc:error` on
   failure. Commit.
5. **doc-edit ping:** subscribe to SuperDoc's change/update event (or the ydoc's
   `update` event as a fallback), debounce ~1s, `postToHost({type:"superdoc:doc-edit"})`.
   Commit.
6. **Env:** `VITE_HOST_ORIGIN` (the SwiftPro origin) in `.env.example`. Dev
   default e.g. `http://localhost:5173`. Commit.
7. **Local end-to-end:** run this app (Vite picks a port — make it match the
   host's `VITE_SUPERDOC_APP_URL`, default `http://localhost:5174`). In `swifter`,
   set `VITE_SUPERDOC_APP_URL` to this app's URL and open
   `/collaboration-tool?editor=superdoc&sourceUrl=<docx>&fileName=...&fileType=docx`.
   Verify: iframe loads → host posts `init` → document renders → host's
   "Loading editor…" overlay clears (it cleared because we posted `editor-ready`).
8. **Deploy** to its own origin (subdomain). Set the host's
   `VITE_SUPERDOC_APP_URL` to the deployed URL.

## Risks / things to verify (don't assume)

- **Package specifier.** Docs show `import { SuperDoc } from "superdoc"`, but the
  npm package is `@harbour-enterprises/superdoc`. Confirm which specifier the
  installed package actually exports (it may alias both). Same for the CSS path.
- **y-websocket vs Hocuspocus.** SuperDoc's `modules.collaboration` is
  provider-agnostic (`{ ydoc, provider }`), and SwiftPro's server is plain
  `y-websocket` (`ws://…:1234` by default). SuperDoc docs show Hocuspocus/YHub
  examples — **confirm** a `y-websocket` `WebsocketProvider` actually drives
  SuperDoc. If not, you may need a Hocuspocus-compatible provider or a shim. The
  host is unaffected (it only passes `wsUrl` + `roomId`).
- **SuperDoc ready/edit events.** The exact event/callback names for "document
  loaded" and "document changed" weren't in the docs excerpt — find them in the
  installed package's types or `docs.superdoc.dev`. Fall back to the `ydoc`
  `update` event for `doc-edit` if no editor-level change event exists.
- **Schema isolation.** SuperDoc collaborates in room `payload.roomId`
  (`…:superdoc`), separate from SwiftPro's legacy y-prosemirror rooms — they have
  incompatible schemas, so they must never share a room. The host already
  guarantees this via the namespacing; just don't undo it.

## Out of scope (matches host MVP)

AI-redline suggestions, version snapshot/restore, and anchored comments across
the bridge are NOT part of this MVP — the host sidebar degrades gracefully
(`onEditorReady(null)`) and backend comments keep working without the editor
adapter. A later phase adds a richer bridge protocol for those.

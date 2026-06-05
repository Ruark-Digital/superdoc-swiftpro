# superdoc-swiftpro

The **AGPL-3.0 companion app** to the proprietary SwiftPro repo (`swifter`). It is
a standalone [SuperDoc](https://superdoc.dev) editor that runs inside a
cross-origin `<iframe>` on SwiftPro's CollaborationToolPage and talks to the host
**only** via `postMessage`.

That arms-length boundary is deliberate: it keeps SuperDoc's AGPL copyleft out of
SwiftPro's proprietary bundle. **SuperDoc must never be imported into SwiftPro** —
it lives here, behind the iframe, and the two apps exchange plain messages.

## License & source

- This app depends on [`@harbour-enterprises/superdoc`](https://www.npmjs.com/package/@harbour-enterprises/superdoc)
  (v1.38.0), which is **AGPL-3.0**. This repository is therefore **AGPL-3.0** — see
  [`LICENSE`](./LICENSE).
- The complete, corresponding source is published at this repository. If you
  deploy this app to a network-accessible origin, the AGPL requires that source
  remain available to its users.

## Architecture

```
┌──────────── swifter (proprietary) ────────────┐
│  IframeEditorPane.tsx                          │
│   • <iframe src={VITE_SUPERDOC_APP_URL}>       │
│   • fetches the .docx → transfers bytes        │
│   • origin-checks every message                │
└───────────────│ postMessage │─────────────────┘
                ▼            ▲
┌──────── THIS REPO: superdoc-swiftpro (AGPL-3.0) ────────┐
│  Vite app                                               │
│   • on load → postMessage `superdoc:ready`              │
│   • on `superdoc:init` → Blob(docBytes) → new SuperDoc  │
│   • y-websocket provider → wsUrl, room = payload.roomId │
│   • posts `editor-ready` / `doc-edit` / `error`         │
└─────────────────────────────────────────────────────────┘
```

## The postMessage contract

The full contract — and the critical `roomId`-already-namespaced gotcha — lives in
[`BUILD-PLAN.md`](./BUILD-PLAN.md). The implementation mirror is
[`src/bridge.ts`](./src/bridge.ts), which is kept in sync with the host's
`swifter/src/pages/CollaborationToolPage/collab/superdocBridge.ts`.

| Direction | `type` | Notes |
|---|---|---|
| host → app | `superdoc:init` | Carries the transferred `.docx` bytes, user, `documentMode`, `roomId` (already `…:superdoc`), `wsUrl`. |
| app → host | `superdoc:ready` | Posted once on load, before anything else. |
| app → host | `superdoc:editor-ready` | After the document loads; optional `{ pageCount }`. |
| app → host | `superdoc:doc-edit` | On document change, debounced ~1s. |
| app → host | `superdoc:error` | `{ message }` on init/load failure. |

**Security:** inbound messages are dropped unless `event.origin === VITE_HOST_ORIGIN`;
outbound messages target that exact origin (never `"*"`).

## Configuration

| Env var | Purpose | Dev default |
|---|---|---|
| `VITE_HOST_ORIGIN` | Origin of the SwiftPro host this app trusts/targets. | `http://localhost:5173` |

Copy [`.env.example`](./.env.example) to `.env` and adjust. The dev server is
pinned to port **5174** ([`vite.config.ts`](./vite.config.ts)) to match SwiftPro's
default `VITE_SUPERDOC_APP_URL`.

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5174
pnpm test         # bridge unit tests (vitest)
pnpm typecheck    # tsc --noEmit
pnpm build        # tsc + vite build → dist/
```

### Local end-to-end with SwiftPro

1. Run this app (`pnpm dev`) — note it serves on `http://localhost:5174`.
2. In `swifter`, set `VITE_SUPERDOC_APP_URL=http://localhost:5174` and run its dev
   server (default `http://localhost:5173`).
3. Open SwiftPro's
   `/collaboration-tool?editor=superdoc&sourceUrl=<docx>&fileName=...&fileType=docx`.
4. Verify: iframe loads → host posts `init` → document renders → the host's
   "Loading editor…" overlay clears (it clears because this app posted
   `superdoc:editor-ready`).

## Deploy

Build with `pnpm build` and serve `dist/` from this app's own origin (a dedicated
subdomain). Set `VITE_HOST_ORIGIN` to the deployed SwiftPro origin, and point
SwiftPro's `VITE_SUPERDOC_APP_URL` at this app's deployed URL.

# superdoc-swiftpro

**AGPL-3.0 companion app** to the proprietary SwiftPro repo (`swifter`). This is
a standalone SuperDoc editor that runs inside a cross-origin `<iframe>` in
SwiftPro's CollaborationToolPage. SwiftPro and this app communicate **only** via
`postMessage` — that isolation is what keeps SuperDoc's AGPL copyleft out of
SwiftPro's proprietary bundle. Never import SuperDoc into SwiftPro.

## Start here

**Read [`BUILD-PLAN.md`](./BUILD-PLAN.md) before doing anything.** It contains the
full context, the exact `postMessage` contract you must satisfy (with a critical
`roomId`-already-namespaced gotcha), the SuperDoc + Yjs API, and a task-by-task
build plan.

## Key facts

- Library: `@harbour-enterprises/superdoc` v1.38.0 — **AGPL-3.0**. This repo is
  therefore AGPL-3.0; keep a `LICENSE` file and publish source.
- Stack to add: Vite + `@harbour-enterprises/superdoc` + `yjs` + `y-websocket`.
  Use `pnpm`.
- Host repo: `C:\Users\HomePC\Documents\GitHub\swifter`, branch
  `feat-collab-superdoc-editor`. The contract's other side is
  `src/pages/CollaborationToolPage/collab/superdocBridge.ts` and
  `components/IframeEditorPane.tsx` there.
- The host renders this app's iframe only on `?editor=superdoc` and points at it
  via its `VITE_SUPERDOC_APP_URL` env var (default `http://localhost:5174`). This
  app validates/targets the host via `VITE_HOST_ORIGIN` (default
  `http://localhost:5173`).

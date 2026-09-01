// Diagnostic harness #2 (NOT part of the app): full-fidelity repro of the
// LIVE iframe path using the app's REAL modules — connectWithTimeout (real
// y-websocket provider against probe-ws-server.mjs on :1235), the real
// buildSuperdocOptions, and the real comments.ts helpers.
//
//   1st load of a room → seed path (document-only render + upgradeToCollaboration)
//   2nd load (reload)  → JOIN path (construction-time modules.collaboration)
//
// Use ?room=<name> to control the room. Results on window.__probe.
import { SuperDoc, BlankDOCX } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import { connectWithTimeout } from "./src/collabProvider";
import { buildSuperdocOptions } from "./src/superdocOptions";
import { captureSelection, createAnchoredComment, focusComment } from "./src/comments";

declare global {
  interface Window {
    __probe: Record<string, unknown>;
  }
}
window.__probe = { status: "starting" };
const log = (...args: unknown[]) => console.log("[probe2]", ...args);

const room = new URLSearchParams(location.search).get("room") ?? "probe-room-1";

async function main() {
  const docBytes = await (await fetch(BlankDOCX)).arrayBuffer();
  const collab = await connectWithTimeout({
    wsUrl: "ws://localhost:1235",
    roomId: room,
    token: "",
    timeoutMs: 9000,
  });
  window.__probe.collabConnected = collab !== null;
  window.__probe.isNewRoom = collab?.isNewRoom ?? null;
  const joinExisting = collab !== null && !collab.isNewRoom;
  window.__probe.path = collab === null ? "document-only" : joinExisting ? "JOIN" : "SEED";
  log("path:", window.__probe.path);

  const payload = {
    docBytes,
    fileName: "probe.docx",
    fileType: "docx",
    documentMode: "editing" as const,
    user: { name: "Probe", email: "probe@example.com" },
    roomId: room,
    wsUrl: "ws://localhost:1235",
    token: "",
  };

  new SuperDoc(
    buildSuperdocOptions(
      payload,
      {
        onReady: ({ superdoc }: { superdoc: any }) => {
          void onReady(superdoc);
        },
        onPaginationUpdate: () => {},
        onEditorUpdate: () => {},
        onException: ({ error }: { error: unknown }) =>
          console.error("[probe2] exception", error),
        onContentError: ({ error }: { error: unknown }) =>
          console.error("[probe2] content error", error),
      },
      joinExisting ? collab : null,
    ) as any,
  );

  async function onReady(superdoc: any) {
    try {
      const editor = superdoc.activeEditor;
      window.__probe.editorFound = Boolean(editor);

      if (collab && collab.isNewRoom) {
        await superdoc
          .upgradeToCollaboration({ ydoc: collab.doc, provider: collab.provider })
          .then(() => (window.__probe.upgraded = true))
          .catch((e: any) => (window.__probe.upgradeError = String(e?.message ?? e)));
        // Seed content so the next (JOIN) load has something to select.
        editor.commands.insertContent(
          "Optimized high-volume data visualization with TanStack Query and Zustand.",
        );
        await new Promise((r) => setTimeout(r, 1500)); // let Yjs flush to server
      }

      // Mirror main.ts: select a range, capture via comments.ts, create.
      editor.commands.setTextSelection({ from: 4, to: 30 });
      const captured = captureSelection(editor);
      window.__probe.captured = captured
        ? { excerpt: captured.excerpt, target: JSON.parse(JSON.stringify(captured.target)) }
        : null;
      log("captured", JSON.stringify(window.__probe.captured));

      // Raw receipt for diagnostics (createAnchoredComment swallows it).
      let rawReceipt: unknown = null;
      let rawError: string | null = null;
      try {
        rawReceipt = editor.doc.comments.create({
          text: "probe2 raw",
          target: captured?.target,
        });
      } catch (e: any) {
        rawError = String((e && (e.stack || e.message)) || e);
      }
      window.__probe.rawReceipt = rawReceipt ? JSON.parse(JSON.stringify(rawReceipt)) : null;
      window.__probe.rawError = rawError;
      log("rawReceipt", JSON.stringify(window.__probe.rawReceipt), rawError);

      // The actual app helper.
      editor.commands.setTextSelection({ from: 6, to: 28 });
      const captured2 = captureSelection(editor);
      const helperId = captured2
        ? createAnchoredComment(editor, "probe2 via helper", captured2.target)
        : null;
      window.__probe.helperId = helperId;
      log("helperId", helperId);

      if (helperId) focusComment(superdoc, helperId);

      window.__probe.status = "done";
      document.title = "PROBE_DONE";
    } catch (e: any) {
      window.__probe.status = "error";
      window.__probe.fatal = String((e && (e.stack || e.message)) || e);
      document.title = "PROBE_ERROR";
      log("fatal", window.__probe.fatal);
    }
  }
}

void main().catch((e) => {
  window.__probe.status = "error";
  window.__probe.fatal = String(e?.stack ?? e);
  document.title = "PROBE_ERROR";
});

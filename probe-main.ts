// Diagnostic harness (NOT part of the app): reproduces the anchored-comment
// flow without the SwiftPro host — blank docx, insert text, select, create a
// comment at the selection, navigateTo it. Results land on window.__probe and
// the page title flips to PROBE_DONE / PROBE_ERROR for automation.
import { SuperDoc, BlankDOCX } from "@harbour-enterprises/superdoc";
import "@harbour-enterprises/superdoc/style.css";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

declare global {
  interface Window {
    __probe: Record<string, unknown>;
  }
}
window.__probe = { status: "starting" };

const log = (...args: unknown[]) => console.log("[probe]", ...args);

new SuperDoc({
  selector: "#editor",
  toolbar: "#probe-toolbar",
  document: BlankDOCX,
  documentMode: "editing",
  user: { name: "Probe", email: "probe@example.com" },
  modules: { comments: {} },
  onReady: ({ superdoc }: { superdoc: any }) => {
    try {
      const editor = superdoc.activeEditor;
      window.__probe.editorFound = Boolean(editor);
      const cases: Record<string, unknown> = {};
      window.__probe.cases = cases;

      // Build a doc shaped like the failing CV: paragraph + bulleted list.
      editor.commands.insertContent("Intro paragraph for the probe document.");
      editor.commands.splitBlock();
      editor.commands.toggleList?.("bulletList") ??
        editor.commands.toggleBulletList?.();
      editor.commands.insertContent(
        "Optimized high-volume data visualization with TanStack Query and Zustand.",
      );
      editor.commands.splitBlock();
      editor.commands.insertContent(
        "Second bullet line for the multi-block selection case.",
      );

      const runCase = (name: string, from: number, to: number) => {
        const out: Record<string, unknown> = {};
        cases[name] = out;
        out.selected = editor.commands.setTextSelection({ from, to });
        const sel = editor.doc.selection.current({ includeText: true });
        out.selection = JSON.parse(JSON.stringify(sel ?? null));
        try {
          const receipt = editor.doc.comments.create({
            text: `probe: ${name}`,
            target: sel?.target,
          });
          out.receipt = receipt ? JSON.parse(JSON.stringify(receipt)) : null;
        } catch (e: any) {
          out.createError = String((e && (e.stack || e.message)) || e);
        }
        log(name, JSON.stringify(out));
      };

      // Find positions: scan the doc text for the bullet line.
      const docText: string = editor.state.doc.textBetween(
        0,
        editor.state.doc.content.size,
        "\n",
      );
      out: {
        window.__probe.docText = docText;
        break out;
      }

      runCase("paragraph", 3, 18);
      // Inside the first bullet: locate "high-volume" via PM positions by
      // walking nodes for the bullet text.
      let bulletFrom = -1;
      editor.state.doc.descendants((node: any, pos: number) => {
        if (bulletFrom === -1 && node.isText && node.text?.includes("Optimized high-volume")) {
          bulletFrom = pos + node.text.indexOf("high-volume");
        }
        return bulletFrom === -1;
      });
      window.__probe.bulletFrom = bulletFrom;
      if (bulletFrom >= 0) runCase("bullet", bulletFrom, bulletFrom + 24);

      // Multi-block: from inside bullet 1 into bullet 2.
      let secondFrom = -1;
      editor.state.doc.descendants((node: any, pos: number) => {
        if (secondFrom === -1 && node.isText && node.text?.includes("Second bullet")) {
          secondFrom = pos + 3;
        }
        return secondFrom === -1;
      });
      if (bulletFrom >= 0 && secondFrom >= 0) {
        runCase("multi-block", bulletFrom, secondFrom + 10);
      }

      // Collab variant — mirrors the app's SEED path: document-only render,
      // then upgradeToCollaboration with a local ydoc + stub provider.
      const ydoc = new Y.Doc();
      const awareness = new Awareness(ydoc);
      const fakeProvider: any = {
        awareness,
        synced: true,
        on: () => {},
        off: () => {},
        connect: () => {},
        disconnect: () => {},
        destroy: () => {},
      };
      void (async () => {
        try {
          await superdoc.upgradeToCollaboration({ ydoc, provider: fakeProvider });
          window.__probe.upgraded = true;
        } catch (e: any) {
          window.__probe.upgradeError = String((e && (e.stack || e.message)) || e);
        }
        try {
          const ed2 = superdoc.activeEditor;
          window.__probe.sameEditorAfterUpgrade = ed2 === editor;
          ed2.commands.setTextSelection({ from: 3, to: 18 });
          const sel2 = ed2.doc.selection.current({ includeText: true });
          const out2: Record<string, unknown> = {
            selection: JSON.parse(JSON.stringify(sel2 ?? null)),
          };
          try {
            const receipt2 = ed2.doc.comments.create({
              text: "probe: post-collab",
              target: sel2?.target,
            });
            out2.receipt = receipt2 ? JSON.parse(JSON.stringify(receipt2)) : null;
          } catch (e: any) {
            out2.createError = String((e && (e.stack || e.message)) || e);
          }
          cases["post-collab"] = out2;
          log("post-collab", JSON.stringify(out2));
        } catch (e: any) {
          cases["post-collab"] = { fatal: String((e && (e.stack || e.message)) || e) };
        }
        window.__probe.status = "done";
        document.title = "PROBE_DONE";
      })();
    } catch (e: any) {
      window.__probe.status = "error";
      window.__probe.fatal = String((e && (e.stack || e.message)) || e);
      document.title = "PROBE_ERROR";
      log("fatal", window.__probe.fatal);
    }
  },
  onException: ({ error }: { error: unknown }) => {
    console.error("[probe] exception", error);
  },
});

// Diagnostic harness: local Yjs websocket server speaking the app's URL shape
// (`/collab?doc=<room>` — see collabSocket.rewriteCollabUrl). No auth.
import http from "node:http";
import { WebSocketServer } from "ws";
import { setupWSConnection } from "@y/websocket-server/utils";

const PORT = 1235;
const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (conn, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const doc =
    url.searchParams.get("doc") ||
    decodeURIComponent(url.pathname.replace(/^\//, "")) ||
    "default";
  console.log("[probe-ws] connection for room:", doc);
  setupWSConnection(conn, req, { docName: doc });
});

server.listen(PORT, () => console.log(`[probe-ws] listening on :${PORT}`));

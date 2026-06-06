// Manual prod-readiness probe: confirms the chosen room name + URL shape
// upgrade against the live collab server (no 502), using the same /collab?doc=
// + access_token subprotocol the host client uses.
//
// Usage:
//   node scripts/ws-probe.mjs "wss://api.swiftpro.tech/api/v1/dev/contract" "<baseRoom>-superdoc" "<jwt>"
import WebSocket from "ws";

const [, , base, room, token] = process.argv;
if (!base || !room) {
  console.error('Usage: node scripts/ws-probe.mjs "<wsBase>" "<room>" "<jwt?>"');
  process.exit(2);
}
const url = new URL(base.replace(/\/+$/, "") + "/collab");
url.searchParams.set("doc", room);
const protocols = token ? ["access_token", token] : [];
console.log("Connecting:", url.toString());

const ws = new WebSocket(url.toString(), protocols);
const timer = setTimeout(() => {
  console.error("TIMEOUT — no open within 10s");
  process.exit(1);
}, 10000);
ws.on("open", () => {
  clearTimeout(timer);
  console.log("OK — socket upgraded (no 502). Room routes correctly.");
  ws.close();
  process.exit(0);
});
ws.on("unexpected-response", (_req, res) => {
  clearTimeout(timer);
  console.error(`HTTP ${res.statusCode} — server rejected the upgrade (e.g. 502).`);
  process.exit(1);
});
ws.on("error", (err) => {
  clearTimeout(timer);
  console.error("ERROR:", err.message);
  process.exit(1);
});

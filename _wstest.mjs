import WebSocket from "ws";
const URL = "wss://coding-challenge-mexico-i62c.onrender.com";
function tryConnect(origin, label) {
  return new Promise((resolve) => {
    const opts = origin ? { headers: { Origin: origin } } : {};
    const ws = new WebSocket(URL, opts);
    const to = setTimeout(() => { ws.terminate(); resolve(`${label}: TIMEOUT`); }, 12000);
    ws.on("open", () => { clearTimeout(to); ws.close(); resolve(`${label}: ✅ CONECTÓ (origin aceptado)`); });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(to); resolve(`${label}: ❌ HTTP ${res.statusCode} (rechazado)`); });
    ws.on("error", (e) => { clearTimeout(to); resolve(`${label}: ❌ ${e.message}`); });
  });
}
console.log(await tryConnect("https://coding-challenge-mexico-teal.vercel.app", "Origin Vercel (sin slash)"));
console.log(await tryConnect("https://coding-challenge-mexico-teal.vercel.app/", "Origin Vercel (con slash)"));
console.log(await tryConnect(null, "Sin Origin (curl-like)"));

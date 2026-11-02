// Beat The Professor — tiny shared-line server (no extra packages needed).
// Serves index.html and keeps ONE waiting line for every phone and laptop.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const INDEX = fs.readFileSync(path.join(__dirname, "index.html"));

const OFFER_MS = 25000;      // how long the next player has to press Start
const ABANDON_MS = 12000;    // match ends if the player stops sending updates
const GONE_MS = 60000;       // removed from line after closing the page this long
const MAX_LINE = 200;

const players = new Map();   // id -> {id, token, name, look, conns, lastSeen, skips}
let queue = [];              // player ids, first = next
let current = null;          // {id, last, sc:[me, pro]}
let offer = null;            // {id, until}
let honour = [];             // [{name, look, score}]
let lastLive = null, liveDirty = false;
const clients = new Set();   // {res, pid}

/* ---------- validation ---------- */
const HEX = /^#[0-9a-fA-F]{6}$/;
const HAIRS = ["buzz", "short", "curly", "long", "bun", "bald"];
const BLOCK = ["fuck","shit","bitch","cunt","dick","piss","slut","fag","nigg","retard","porn","cock","wank","whore","penis","vagina","boob","sex"];
function cleanLook(l) {
  if (!l || typeof l !== "object") return null;
  const hex = c => typeof c === "string" && HEX.test(c);
  const look = { skin: l.skin, hair: l.hair, hairc: l.hairc, jersey: l.jersey, num: Number(l.num), band: l.band };
  if (!hex(look.skin) || !hex(look.hairc) || !hex(look.jersey) || !HAIRS.includes(look.hair)) return null;
  if (!(look.band === "none" || hex(look.band))) return null;
  if (!Number.isInteger(look.num) || look.num < 0 || look.num > 99) return null;
  return look;
}
function nameError(n) {
  if (typeof n !== "string") return "Pick a username.";
  if (n.length < 2 || n.length > 12) return "Use 2 to 12 characters.";
  if (!/^[A-Za-z0-9 _.-]+$/.test(n)) return "Use letters, numbers, spaces, - _ or . only.";
  const low = n.toLowerCase().replace(/[^a-z]/g, "");
  if (BLOCK.some(w => low.includes(w)) || /\bass\b/i.test(n)) return "Pick a school-friendly name.";
  if (n.toLowerCase().includes("professor")) return "Only one Professor allowed on this court!";
  const active = [...queue, current && current.id].filter(Boolean);
  if (active.some(id => { const p = players.get(id); return p && p.name.toLowerCase() === n.toLowerCase(); }))
    return "Someone in line already has that name.";
  return "";
}

/* ---------- broadcasting ---------- */
const pub = p => ({ id: p.id, name: p.name, look: p.look });
function lobbyData() {
  const cp = current && players.get(current.id);
  return {
    queue: queue.map(id => players.get(id)).filter(Boolean).map(pub),
    current: cp ? { ...pub(cp), sc: current.sc } : null,
    offer: offer ? { id: offer.id, left: Math.max(0, offer.until - Date.now()) } : null,
    honour: honour.slice(0, 10),
  };
}
function send(res, ev, data) { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} }
function broadcastLobby() {
  const base = lobbyData();
  for (const c of clients) send(c.res, "lobby", { ...base, you: c.pid ? players.has(c.pid) : null });
}
setInterval(() => {
  if (!liveDirty) return; liveDirty = false;
  for (const c of clients) send(c.res, "live", lastLive);
}, 100);

/* ---------- line keeper ---------- */
setInterval(() => {
  const now = Date.now(); let dirty = false;
  for (const p of players.values()) if (p.conns > 0) p.lastSeen = now;
  const before = queue.length;
  queue = queue.filter(id => { const p = players.get(id); return p && (p.conns > 0 || now - p.lastSeen < GONE_MS); });
  if (queue.length !== before) dirty = true;
  if (current && now - current.last > ABANDON_MS) { current = null; lastLive = null; liveDirty = true; dirty = true; }
  if (offer) {
    if (!queue.includes(offer.id)) { offer = null; dirty = true; }
    else if (now > offer.until) {
      const id = offer.id, p = players.get(id);
      queue = queue.filter(x => x !== id);
      if (p) { p.skips = (p.skips || 0) + 1; if (p.skips < 2) queue.push(id); }
      offer = null; dirty = true;
    }
  }
  if (!current && !offer && queue.length) { offer = { id: queue[0], until: now + OFFER_MS }; dirty = true; }
  for (const [id, p] of players) {
    if (p.conns <= 0 && now - p.lastSeen > 6 * 3600 * 1000 && !queue.includes(id) && !(current && current.id === id)) players.delete(id);
  }
  if (dirty) broadcastLobby();
}, 1000);
setInterval(() => { for (const c of clients) { try { c.res.write(": ping\n\n"); } catch (e) {} } }, 20000);

/* ---------- http ---------- */
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0, chunks = [];
    req.on("data", d => { size += d.length; if (size > 10000) { req.destroy(); resolve(null); } else chunks.push(d); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}
function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function auth(b) {
  if (!b) return null;
  const p = players.get(b.id);
  return p && typeof b.token === "string" && p.token === b.token ? p : null;
}
function removePlayer(id) {
  queue = queue.filter(x => x !== id);
  if (offer && offer.id === id) offer = null;
  if (current && current.id === id) { current = null; lastLive = null; liveDirty = true; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(INDEX);
  }
  if (req.method === "GET" && p === "/api/hello") return json(res, 200, { ok: true });

  if (req.method === "GET" && p === "/api/events") {
    if (clients.size > 800) { res.writeHead(503); return res.end(); }
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive", "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const pid = url.searchParams.get("pid") || null;
    const client = { res, pid };
    clients.add(client);
    const pl = pid && players.get(pid);
    if (pl) { pl.conns = (pl.conns || 0) + 1; pl.lastSeen = Date.now(); }
    send(res, "lobby", { ...lobbyData(), you: pid ? players.has(pid) : null });
    if (lastLive) send(res, "live", lastLive);
    req.on("close", () => {
      clients.delete(client);
      const q = pid && players.get(pid);
      if (q) { q.conns = Math.max(0, (q.conns || 1) - 1); q.lastSeen = Date.now(); }
    });
    return;
  }

  if (req.method !== "POST") { res.writeHead(404); return res.end("Not found"); }
  const b = await readJson(req);
  if (!b) return json(res, 400, { error: "Bad request." });

  if (p === "/api/join") {
    const old = auth({ id: b.oldId, token: b.oldToken });
    if (old) { removePlayer(old.id); players.delete(old.id); }
    const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
    const err = nameError(name); if (err) return json(res, 400, { error: err });
    const look = cleanLook(b.look); if (!look) return json(res, 400, { error: "That avatar didn't work. Try again." });
    if (queue.length >= MAX_LINE) return json(res, 400, { error: "The line is full right now. Try again soon." });
    const id = crypto.randomBytes(6).toString("hex"), token = crypto.randomBytes(16).toString("hex");
    players.set(id, { id, token, name, look, conns: 0, lastSeen: Date.now(), skips: 0 });
    queue.push(id);
    broadcastLobby();
    return json(res, 200, { id, token, name, look });
  }

  const me = auth(b);
  if (!me) return json(res, 401, { error: "unknown player" });

  if (p === "/api/leave") { removePlayer(me.id); players.delete(me.id); broadcastLobby(); return json(res, 200, { ok: true }); }
  if (p === "/api/requeue") {
    if (!queue.includes(me.id) && !(current && current.id === me.id)) { me.skips = 0; queue.push(me.id); broadcastLobby(); }
    return json(res, 200, { ok: true });
  }
  if (p === "/api/start") {
    if (offer && offer.id === me.id && !current) {
      current = { id: me.id, last: Date.now(), sc: [0, 0] };
      queue = queue.filter(x => x !== me.id); offer = null; me.skips = 0; lastLive = null;
      broadcastLobby();
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { ok: false });
  }
  if (p === "/api/live") {
    if (current && current.id === me.id) {
      current.last = Date.now();
      const s = b.s;
      if (s && typeof s === "object" && JSON.stringify(s).length < 3000) {
        lastLive = s; liveDirty = true;
        if (Array.isArray(s.sc) && (s.sc[0] !== current.sc[0] || s.sc[1] !== current.sc[1])) {
          current.sc = [Math.min(9, s.sc[0] | 0), Math.min(9, s.sc[1] | 0)]; broadcastLobby();
        }
      }
    }
    res.writeHead(204); return res.end();
  }
  if (p === "/api/end") {
    if (current && current.id === me.id) {
      const sc = Array.isArray(b.score) ? [Math.min(9, b.score[0] | 0), Math.min(9, b.score[1] | 0)] : current.sc;
      if (b.won === true && sc[0] >= 3) { honour.unshift({ name: me.name, look: me.look, score: `${sc[0]} – ${sc[1]}` }); honour = honour.slice(0, 30); }
      current = null; lastLive = null; liveDirty = true;
      broadcastLobby();
    }
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "Not found" });
});
server.listen(PORT, () => console.log("Beat The Professor running on port " + PORT));

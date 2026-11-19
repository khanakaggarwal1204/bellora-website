/* BELLORA — backend
 * Zero dependencies: just Node 18+.   Run:  node server.js
 *
 *   POST   /api/reservations        public   – submit a reservation request
 *   GET    /api/reservations        admin    – list requests (newest first)
 *   PATCH  /api/reservations/:id    admin    – set status: new | confirmed | cancelled
 *   GET    /admin.html              admin dashboard (asks for the admin token)
 *
 * Admin routes need:  Authorization: Bearer <ADMIN_TOKEN>
 */
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

/* ── tiny .env loader ───────────────────────────────────── */
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) { /* no .env – fine */ }

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DATA_FILE = path.join(__dirname, "data", "reservations.json");

const TIMES = ["12:30 PM", "1:30 PM", "2:30 PM", "7:00 PM", "8:00 PM", "9:00 PM", "10:00 PM"];
const GUESTS = ["2 Guests", "3 Guests", "4 Guests", "5 Guests", "6 Guests", "7+ / Private Dining"];
const STATUSES = ["new", "confirmed", "cancelled"];

/* ── static files (allow-list, never expose server.js / data / .env) ── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
};
const PUBLIC_ROOTS = ["index.html", "admin.html", "css", "js", "assets"];

/* ── storage (JSON file, written atomically, serialised through a queue) ── */
let queue = Promise.resolve();
const withLock = (fn) => (queue = queue.then(fn, fn));

async function readAll() {
  try { return JSON.parse(await fsp.readFile(DATA_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
async function writeAll(list) {
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2));
  await fsp.rename(tmp, DATA_FILE);
}

/* ── helpers ───────────────────────────────────────────── */
function send(res, status, body, headers = {}) {
  const isJson = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Payload too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* simple per-IP rate limit: 5 reservation requests / hour */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), windowMs = 60 * 60 * 1000;
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now); hits.set(ip, recent);
  return recent.length > 5;
}
setInterval(() => { const now = Date.now(); for (const [ip, t] of hits) if (!t.some((x) => now - x < 3600e3)) hits.delete(ip); }, 600e3).unref();

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function validate(b) {
  const errors = {};
  const name = clean(b.name, 80);
  const phone = clean(b.phone, 25);
  const digits = phone.replace(/\D/g, "");
  const date = clean(b.date, 10);
  const time = clean(b.time, 12);
  const guests = clean(b.guests, 30);
  const notes = clean(b.notes, 500);

  if (name.length < 2) errors.name = "Please enter your name.";
  if (digits.length < 10 || digits.length > 13 || !/^[+\d\s()-]+$/.test(phone)) errors.phone = "Please enter a valid phone number.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) errors.date = "Please choose a date.";
  else {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [y, m, d] = date.split("-").map(Number);
    if (new Date(y, m - 1, d) < today) errors.date = "That date has already passed.";
  }
  if (!TIMES.includes(time)) errors.time = "Please choose a time.";
  if (!GUESTS.includes(guests)) errors.guests = "Please choose party size.";

  return { errors, value: { name, phone, date, time, guests, notes } };
}

/* ── API ───────────────────────────────────────────────── */
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || "unknown";

  if (url.pathname === "/api/reservations" && req.method === "POST") {
    const body = await readJson(req);
    if (body.website) return send(res, 200, { ok: true });          // honeypot: pretend success to bots
    if (rateLimited(ip)) return send(res, 429, { ok: false, error: "Too many requests. Please call us instead." });

    const { errors, value } = validate(body);
    if (Object.keys(errors).length) return send(res, 422, { ok: false, errors });

    const record = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: "new", ...value };
    await withLock(async () => { const all = await readAll(); all.push(record); await writeAll(all); });
    console.log(`[reservation] ${record.date} ${record.time} · ${record.guests} · ${record.name} · ${record.phone}`);
    return send(res, 201, { ok: true, id: record.id });
  }

  if (url.pathname === "/api/reservations" && req.method === "GET") {
    if (!isAdmin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const all = await readAll();
    return send(res, 200, { ok: true, reservations: all.reverse() });
  }

  const m = url.pathname.match(/^\/api\/reservations\/([0-9a-f-]{36})$/);
  if (m && req.method === "PATCH") {
    if (!isAdmin(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    const { status } = await readJson(req);
    if (!STATUSES.includes(status)) return send(res, 422, { ok: false, error: "Invalid status" });
    let found = null;
    await withLock(async () => {
      const all = await readAll();
      found = all.find((r) => r.id === m[1]);
      if (found) { found.status = status; await writeAll(all); }
    });
    return found ? send(res, 200, { ok: true, reservation: found }) : send(res, 404, { ok: false, error: "Not found" });
  }

  return send(res, 404, { ok: false, error: "Not found" });
}

/* ── static ────────────────────────────────────────────── */
async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const full = path.normalize(path.join(__dirname, rel));
  const top = path.relative(__dirname, full).split(path.sep)[0];
  if (!full.startsWith(__dirname + path.sep) || !PUBLIC_ROOTS.includes(top)) return send(res, 404, "Not found");
  try {
    const data = await fsp.readFile(full);
    const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": top === "assets" ? "public, max-age=86400" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch { send(res, 404, "Not found"); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { ok: false, error: status === 500 ? "Server error" : err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Bellora running → http://localhost:${PORT}`);
  if (!ADMIN_TOKEN) console.log("⚠  ADMIN_TOKEN is not set: the admin dashboard and reservation list are disabled.");
});

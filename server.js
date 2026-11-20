/* BELLORA — backend
 * Zero dependencies: just Node 18+.   Run:  node server.js
 *
 *   POST   /api/reservations                 public   – submit a reservation request
 *   GET    /api/reservations                 admin    – list/filter reservations
 *   PATCH  /api/reservations/:id             admin    – update status or booking details
 *   GET    /api/admin/overview               admin    – dashboard statistics and summaries
 *   GET    /api/admin/reservations           admin    – filtered reservation list
 *   POST   /api/admin/reservations           admin    – create a manual/offline reservation
 *   GET    /api/admin/reservations/export    admin    – export CSV or XLSX
 *   GET    /admin.html                       admin dashboard (asks for the admin token)
 *   GET    /api/reels                        public   – Instagram reels for the homepage reel screen
 *
 * Admin routes need:  Authorization: Bearer <ADMIN_TOKEN>
 */
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { deflateRawSync } = require("zlib");

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
const STATUSES = ["new", "confirmed", "cancelled", "rejected"];
const DETAIL_KEYS = ["name", "phone", "date", "time", "guests", "guestCount", "notes"];
const PERIODS = ["all", "upcoming", "past"];
const SORTS = ["newest", "oldest", "date-asc", "date-desc", "guests-asc", "guests-desc"];

/* ── static files (allow-list, never expose server.js / data / .env) ── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const PUBLIC_ROOTS = ["index.html", "admin.html", "css", "js", "assets"];

/* ── storage (JSON file, written atomically, serialised through a queue) ── */
let queue = Promise.resolve();
const withLock = (fn) => (queue = queue.then(fn, fn));

async function readAll() {
  try {
    const parsed = JSON.parse(await fsp.readFile(DATA_FILE, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.reservations)) return parsed.reservations;
    return [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
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

function sendFile(res, status, body, filename, contentType) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(body);
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

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, { ok: false, error: "Unauthorized" });
  return false;
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

/* ── dates, guests and validation ──────────────────────── */
const pad = (n) => String(n).padStart(2, "0");
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayKey() { return dateKey(new Date()); }
function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function isValidDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key || "")) return false;
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function addDays(key, n) {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
function startOfWeek(key) {
  const d = parseDateKey(key);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return dateKey(d);
}
function endOfMonth(key) {
  const [y, m] = key.split("-").map(Number);
  return dateKey(new Date(y, m, 0));
}
function timeToMinutes(value) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") hour += 12;
  return hour * 60 + Number(m[2]);
}
function toCount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function parseGuestCount(value) {
  const m = String(value ?? "").match(/\d+/);
  return m ? Number(m[0]) : null;
}
function guestCountOf(record) {
  return toCount(record.guestCount) || parseGuestCount(record.guests) || 0;
}
function guestLabel(count) {
  return `${count} Guest${count === 1 ? "" : "s"}`;
}

function validateDetails(body, { admin = false, allowPast = false } = {}) {
  const errors = {};
  const name = clean(body.name, 80);
  const phone = clean(body.phone, 25);
  const digits = phone.replace(/\D/g, "");
  const date = clean(body.date, 10);
  const time = clean(body.time, 12);
  let guests = clean(body.guests, 30);
  const notes = clean(body.notes, 500);

  if (name.length < 2) errors.name = "Please enter your name.";
  if (digits.length < 10 || digits.length > 13 || !/^[+\d\s()-]+$/.test(phone)) errors.phone = "Please enter a valid phone number.";
  if (!isValidDateKey(date)) errors.date = "Please choose a valid date.";
  else if (!allowPast && date < todayKey()) errors.date = "That date has already passed.";
  if (!TIMES.includes(time)) errors.time = "Please choose a time.";

  let guestCount = toCount(body.guestCount) || parseGuestCount(guests);
  if (admin) {
    if (!guestCount || guestCount > 50) errors.guests = "Enter a party size between 1 and 50.";
    else guests = guestLabel(guestCount);
  } else {
    if (!GUESTS.includes(guests)) errors.guests = "Please choose party size.";
    else guestCount = parseGuestCount(guests);
  }

  return { errors, value: { name, phone, date, time, guests, guestCount, notes } };
}

/* ── filtering and sorting ─────────────────────────────── */
function parseReservationQuery(url) {
  const query = { statuses: [], search: "", from: "", to: "", guestCount: null, period: "all", sort: "newest" };

  const statusParam = url.searchParams.get("status");
  if (statusParam) {
    query.statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (query.statuses.some((s) => !STATUSES.includes(s))) return { error: "Invalid status filter" };
  }

  query.search = clean(url.searchParams.get("search") || "", 80).toLowerCase();

  for (const key of ["from", "to"]) {
    const value = url.searchParams.get(key);
    if (value) {
      if (!isValidDateKey(value)) return { error: `Invalid ${key} date` };
      query[key] = value;
    }
  }

  const guestParam = url.searchParams.get("guestCount");
  if (guestParam) {
    const n = Number(guestParam);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { error: "Invalid guest count" };
    query.guestCount = n;
  }

  const period = url.searchParams.get("period") || "all";
  if (!PERIODS.includes(period)) return { error: "Invalid period" };
  query.period = period;

  const sort = url.searchParams.get("sort") || "newest";
  if (!SORTS.includes(sort)) return { error: "Invalid sort" };
  query.sort = sort;

  return { query };
}

function applyReservationFilters(records, query) {
  const today = todayKey();
  let list = records.slice();

  if (query.statuses.length) list = list.filter((r) => query.statuses.includes(r.status));
  if (query.search) {
    list = list.filter((r) =>
      String(r.name || "").toLowerCase().includes(query.search) ||
      String(r.phone || "").toLowerCase().includes(query.search) ||
      String(r.notes || "").toLowerCase().includes(query.search) ||
      String(r.id || "").toLowerCase().includes(query.search)
    );
  }
  if (query.from) list = list.filter((r) => r.date >= query.from);
  if (query.to) list = list.filter((r) => r.date <= query.to);
  if (query.guestCount) list = list.filter((r) => guestCountOf(r) === query.guestCount);
  if (query.period === "upcoming") list = list.filter((r) => r.date >= today);
  if (query.period === "past") list = list.filter((r) => r.date < today);

  const createdDesc = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || String(b.id).localeCompare(String(a.id));
  const reservationAsc = (a, b) => String(a.date).localeCompare(String(b.date)) ||
    (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999) ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""));

  switch (query.sort) {
    case "oldest": list.sort((a, b) => -createdDesc(a, b)); break;
    case "date-asc": list.sort(reservationAsc); break;
    case "date-desc": list.sort((a, b) => -reservationAsc(a, b)); break;
    case "guests-asc": list.sort((a, b) => guestCountOf(a) - guestCountOf(b) || reservationAsc(a, b)); break;
    case "guests-desc": list.sort((a, b) => guestCountOf(b) - guestCountOf(a) || reservationAsc(a, b)); break;
    default: list.sort(createdDesc);
  }
  return list;
}

/* ── dashboard statistics ──────────────────────────────── */
function emptyStat() {
  return { total: 0, pending: 0, confirmed: 0, cancelled: 0, rejected: 0, guests: 0 };
}
function addStat(bucket, record) {
  bucket.total += 1;
  if (record.status === "new") bucket.pending += 1;
  if (record.status === "confirmed") bucket.confirmed += 1;
  if (record.status === "cancelled") bucket.cancelled += 1;
  if (record.status === "rejected") bucket.rejected += 1;
  bucket.guests += guestCountOf(record);
}
function statFor(records, predicate) {
  const bucket = emptyStat();
  records.filter(predicate).forEach((r) => addStat(bucket, r));
  return bucket;
}
function periodStats(records, from, to) {
  return { from, to, ...statFor(records, (r) => r.date >= from && r.date <= to) };
}
function dailySeries(records, today) {
  return Array.from({ length: 14 }, (_, i) => {
    const key = addDays(today, i - 13);
    return { date: key, ...statFor(records, (r) => r.date === key) };
  });
}
function weeklySeries(records, today) {
  const currentWeek = startOfWeek(today);
  return Array.from({ length: 8 }, (_, i) => {
    const from = addDays(currentWeek, (i - 7) * 7);
    const to = addDays(from, 6);
    return { from, to, ...statFor(records, (r) => r.date >= from && r.date <= to) };
  });
}
function monthlySeries(records, today) {
  const [year, month] = today.split("-").map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(year, month - 12 + i, 1);
    const key = dateKey(d).slice(0, 7);
    return { month: key, ...statFor(records, (r) => String(r.date || "").startsWith(key)) };
  });
}
function reservationAsc(a, b) {
  return String(a.date).localeCompare(String(b.date)) ||
    (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999) ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}
function buildOverview(records) {
  const today = todayKey();
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);
  const monthStart = `${today.slice(0, 7)}-01`;
  const totals = emptyStat();
  records.forEach((r) => addStat(totals, r));

  const byCreatedDesc = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || String(b.id).localeCompare(String(a.id));
  const upcoming = records
    .filter((r) => r.date >= today && r.status !== "cancelled" && r.status !== "rejected")
    .sort(reservationAsc)
    .slice(0, 8);

  return {
    generatedAt: new Date().toISOString(),
    totals,
    periods: {
      today: periodStats(records, today, today),
      week: periodStats(records, weekStart, weekEnd),
      month: periodStats(records, monthStart, endOfMonth(today)),
    },
    daily: dailySeries(records, today),
    weekly: weeklySeries(records, today),
    monthly: monthlySeries(records, today),
    recentEnquiries: records.filter((r) => !r.source || r.source === "website").sort(byCreatedDesc).slice(0, 8),
    upcomingReservations: upcoming,
  };
}

/* ── exports ───────────────────────────────────────────── */
const EXPORT_HEADERS = ["Reservation ID", "Created", "Updated", "Status", "Source", "Name", "Phone", "Reservation Date", "Time", "Guests", "Party Size", "Notes"];

function exportRows(records) {
  return records.map((r) => [
    r.id || "", r.createdAt || "", r.updatedAt || "", r.status || "", r.source || "website",
    r.name || "", r.phone || "", r.date || "", r.time || "", r.guests || "", guestCountOf(r), r.notes || "",
  ]);
}
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function toCsv(rows) {
  return "\uFEFF" + [EXPORT_HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
function colName(index) {
  let name = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}
function worksheetXml(rows) {
  const sheetRows = [EXPORT_HEADERS, ...rows].map((row, rowIndex) => {
    const cells = row.map((value, cellIndex) => {
      const ref = `${colName(cellIndex + 1)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    centrals.push({ name, crc, compressedSize: compressed.length, size: data.length, offset });
    offset += 30 + name.length + compressed.length;
  }

  const centralStart = offset;
  const centralBuffers = centrals.map((entry) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    return Buffer.concat([header, entry.name]);
  });
  const centralSize = centralBuffers.reduce((sum, buf) => sum + buf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centralBuffers, end]);
}
function toXlsx(rows) {
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Reservations" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", worksheetXml(rows)],
  ];
  return zipStore(files.map(([name, data]) => ({ name, data })));
}

/* ── Instagram reels ───────────────────────────────────────
 * 1) If IG_ACCESS_TOKEN is set, reels are pulled live from the Instagram API
 *    (graph.instagram.com) and cached for 30 minutes. The token is renewed
 *    automatically (they expire after 60 days) and never leaves the server.
 * 2) Otherwise, video files placed in assets/reels/ (mp4/webm) autoplay in a loop.
 * 3) Otherwise, reel links listed in data/reels.json use Instagram's embed player
 *    (tap-to-play: Instagram does not allow embeds to autoplay).
 * 4) If none are available the page shows a "follow us" card instead.
 */
const IG_TOKEN_FILE = path.join(__dirname, "data", "ig-token.json");
const REELS_FILE = path.join(__dirname, "data", "reels.json");
const REELS_TTL = 30 * 60 * 1000;
const IG_PROFILE = "https://www.instagram.com/bellora.elegantly/";
const envIgToken = process.env.IG_ACCESS_TOKEN || "";
let igToken = envIgToken;
try {
  const saved = JSON.parse(fs.readFileSync(IG_TOKEN_FILE, "utf8"));
  if (saved.token && saved.from === envIgToken) igToken = saved.token; // a newer token in .env wins
} catch (_) { /* nothing saved yet */ }

async function refreshIgToken() {
  if (!igToken) return;
  try {
    const r = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(igToken)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
    igToken = j.access_token;
    await fsp.mkdir(path.dirname(IG_TOKEN_FILE), { recursive: true });
    await fsp.writeFile(IG_TOKEN_FILE, JSON.stringify({ token: igToken, from: envIgToken, refreshedAt: new Date().toISOString() }), { mode: 0o600 });
    console.log("[reels] Instagram token refreshed");
  } catch (e) {
    console.warn("[reels] token refresh skipped:", e.message); // e.g. token is <24h old – harmless
  }
}

async function instagramReels() {
  const fields = "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp";
  const r = await fetch(
    `https://graph.instagram.com/me/media?fields=${fields}&limit=50&access_token=${encodeURIComponent(igToken)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
  return (j.data || [])
    .filter((m) => m.media_type === "VIDEO" && m.media_product_type === "REELS" && m.media_url)
    .slice(0, 9)
    .map((m) => ({ id: m.id, video: m.media_url, poster: m.thumbnail_url || "", permalink: m.permalink, caption: clean(m.caption, 140), timestamp: m.timestamp }));
}

const REELS_DIR = path.join(__dirname, "assets", "reels");
const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;

/* video files dropped into assets/reels/ – played natively, in filename order */
async function localReels() {
  try {
    const files = await fsp.readdir(REELS_DIR);
    const posters = new Map(files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => [f.replace(/\.[^.]+$/, "").toLowerCase(), f]));
    return files
      .filter((f) => VIDEO_RE.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => {
        const poster = posters.get(f.replace(/\.[^.]+$/, "").toLowerCase());
        return {
          id: f,
          video: "/assets/reels/" + encodeURIComponent(f),
          poster: poster ? "/assets/reels/" + encodeURIComponent(poster) : "",
          permalink: IG_PROFILE,
        };
      });
  } catch { return []; }
}

/* Instagram links in data/reels.json – shown with Instagram's own player (no autoplay possible) */
async function manualReels() {
  try {
    const raw = JSON.parse(await fsp.readFile(REELS_FILE, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.reels || [];
    return list
      .map((u) => String(u).match(/instagram\.com\/(reel|reels|p)\/([A-Za-z0-9_-]{5,20})/))
      .filter(Boolean)
      .slice(0, 12)
      .map((m) => {
        const kind = m[1] === "p" ? "p" : "reel";
        const permalink = `https://www.instagram.com/${kind}/${m[2]}/`;
        return { id: m[2], permalink, embedUrl: `${permalink}embed/` };
      });
  } catch { return []; }
}

let reelsCache = null; // only the Instagram API result is cached; local/manual lists are cheap to re-read
async function loadReels() {
  if (igToken) {
    if (reelsCache && Date.now() - reelsCache.at < REELS_TTL) return reelsCache.body;
    try {
      const reels = await instagramReels();
      if (reels.length) {
        reelsCache = { at: Date.now(), body: { source: "instagram", reels } };
        return reelsCache.body;
      }
    } catch (e) {
      console.error("[reels] Instagram API error:", e.message);
      if (reelsCache) return reelsCache.body; // keep serving the last good copy
    }
  }
  const local = await localReels();
  if (local.length) return { source: "local", reels: local };
  return { source: "manual", reels: await manualReels() };
}

/* ── API ───────────────────────────────────────────────── */
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || "unknown";

  if (url.pathname === "/api/reservations" && req.method === "POST") {
    const body = await readJson(req);
    if (body.website) return send(res, 200, { ok: true });          // honeypot: pretend success to bots
    if (rateLimited(ip)) return send(res, 429, { ok: false, error: "Too many requests. Please call us instead." });

    const { errors, value } = validateDetails(body);
    if (Object.keys(errors).length) return send(res, 422, { ok: false, errors });

    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, status: "new", source: "website", ...value };
    await withLock(async () => { const all = await readAll(); all.push(record); await writeAll(all); });
    console.log(`[reservation] ${record.date} ${record.time} · ${record.guests} · ${record.name} · ${record.phone}`);
    return send(res, 201, { ok: true, id: record.id });
  }

  if (url.pathname === "/api/reels" && req.method === "GET") {
    const data = await loadReels();
    return send(res, 200, { ok: true, profile: IG_PROFILE, ...data }, { "Cache-Control": "public, max-age=300" });
  }

  if (url.pathname === "/api/admin/overview" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    return send(res, 200, { ok: true, overview: buildOverview(await readAll()) });
  }

  if (url.pathname === "/api/admin/reservations/export" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const format = (url.searchParams.get("format") || "csv").toLowerCase();
    if (!["csv", "xlsx"].includes(format)) return send(res, 422, { ok: false, error: "Format must be csv or xlsx" });
    const parsed = parseReservationQuery(url);
    if (parsed.error) return send(res, 422, { ok: false, error: parsed.error });
    const records = applyReservationFilters(await readAll(), parsed.query);
    const rows = exportRows(records);
    const filename = `bellora-reservations-${todayKey()}.${format}`;
    if (format === "csv") {
      return sendFile(res, 200, toCsv(rows), filename, "text/csv; charset=utf-8");
    }
    return sendFile(res, 200, toXlsx(rows), filename, MIME[".xlsx"]);
  }

  if (url.pathname === "/api/admin/reservations" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const parsed = parseReservationQuery(url);
    if (parsed.error) return send(res, 422, { ok: false, error: parsed.error });
    const records = applyReservationFilters(await readAll(), parsed.query);
    return send(res, 200, { ok: true, reservations: records, count: records.length });
  }

  if (url.pathname === "/api/admin/reservations" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const { errors, value } = validateDetails(body, { admin: true, allowPast: true });
    if (Object.keys(errors).length) return send(res, 422, { ok: false, errors });
    const status = body.status ?? "confirmed";
    if (!STATUSES.includes(status)) return send(res, 422, { ok: false, error: "Invalid status" });

    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, status, source: "manual", ...value };
    await withLock(async () => { const all = await readAll(); all.push(record); await writeAll(all); });
    console.log(`[manual reservation] ${record.date} ${record.time} · ${record.guests} · ${record.name} · ${record.phone}`);
    return send(res, 201, { ok: true, reservation: record });
  }

  if (url.pathname === "/api/reservations" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const parsed = parseReservationQuery(url);
    if (parsed.error) return send(res, 422, { ok: false, error: parsed.error });
    return send(res, 200, { ok: true, reservations: applyReservationFilters(await readAll(), parsed.query) });
  }

  const m = url.pathname.match(/^\/api\/reservations\/([0-9a-f-]{36})$/);
  if (m && req.method === "PATCH") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");
    const hasDetails = DETAIL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (!hasStatus && !hasDetails) return send(res, 422, { ok: false, error: "No changes supplied" });
    if (hasStatus && !STATUSES.includes(body.status)) return send(res, 422, { ok: false, error: "Invalid status" });

    let outcome;
    await withLock(async () => {
      const all = await readAll();
      const index = all.findIndex((r) => r.id === m[1]);
      if (index === -1) { outcome = { status: 404, body: { ok: false, error: "Not found" } }; return; }

      const current = all[index];
      const next = { ...current };
      if (hasStatus) next.status = body.status;

      if (hasDetails) {
        const candidate = { ...current };
        for (const key of DETAIL_KEYS) {
          if (Object.prototype.hasOwnProperty.call(body, key)) candidate[key] = body[key];
        }
        const { errors, value } = validateDetails(candidate, { admin: true, allowPast: true });
        if (Object.keys(errors).length) { outcome = { status: 422, body: { ok: false, errors } }; return; }
        Object.assign(next, value);
      }

      next.updatedAt = new Date().toISOString();
      all[index] = next;
      await writeAll(all);
      outcome = { status: 200, body: { ok: true, reservation: next } };
    });

    return send(res, outcome.status, outcome.body);
  }

  return send(res, 404, { ok: false, error: "Not found" });
}

/* video needs HTTP Range support (Safari/iOS refuse to play without it) */
async function serveVideo(req, res, full) {
  const st = await fsp.stat(full);
  if (!st.isFile()) throw new Error("not a file");
  const headers = {
    "Content-Type": MIME[path.extname(full).toLowerCase()] || "video/mp4",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=86400",
  };
  let start = 0, end = st.size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      if (m[1] === "") start = Math.max(0, st.size - Number(m[2]));
      else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    }
    if (!m || start > end || start >= st.size) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  }
  headers["Content-Length"] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(full, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
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
    if (VIDEO_RE.test(full)) return await serveVideo(req, res, full);
    const data = await fsp.readFile(full);
    const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": top === "assets" ? "public, max-age=86400" : "no-cache",
    };
    if (path.basename(full) === "admin.html") {
      headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'";
      headers["X-Frame-Options"] = "DENY";
      headers["Referrer-Policy"] = "no-referrer";
    }
    res.writeHead(200, headers);
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
  if (igToken) {
    setTimeout(refreshIgToken, 10 * 1000).unref();
    setInterval(refreshIgToken, 7 * 24 * 3600 * 1000).unref();
  } else console.log("ℹ  IG_ACCESS_TOKEN is not set: reels come from data/reels.json (or a follow-us card).");
  if (!ADMIN_TOKEN) console.log("⚠  ADMIN_TOKEN is not set: the admin dashboard and reservation list are disabled.");
});

"use strict";
/*
 * «Дело в коробке» — складская система (WMS).
 * Сервер без внешних зависимостей: node:http + встроенная SQLite (node:sqlite).
 * Данные лежат в DATA_DIR (по умолчанию /data — постоянный диск на хостинге).
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const BUF = "PRIEM";
const SESSION_DAYS = 30;
const VERSION = require("./package.json").version;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "backups"), { recursive: true });

/* ---------- нормализация (та же, что в браузере) ---------- */
const norm = s => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const LOOK = { "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y" };
const normCell = s => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "").replace(/[АВЕКМНОРСТХУ]/g, c => LOOK[c]);
const str = (s, max = 300) => String(s ?? "").trim().slice(0, max);
const int = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : NaN; };
const now = () => new Date().toISOString();

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const conflict = msg => new HttpError(409, msg);

/* ---------- база ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, "sklad.db"));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, last_seen TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stock(
  id INTEGER PRIMARY KEY, cell TEXT NOT NULL, client TEXT NOT NULL, article TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL, ckey TEXT NOT NULL, akey TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(cell, ckey, akey));
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, client TEXT NOT NULL, article TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  barcodes TEXT NOT NULL DEFAULT '[]', ckey TEXT NOT NULL, akey TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(ckey, akey));
CREATE TABLE IF NOT EXISTS cells(cell TEXT PRIMARY KEY, zone TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ops(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, client TEXT, article TEXT, name TEXT,
  qty INTEGER, cell TEXT, from_cell TEXT, doc TEXT, note TEXT, user_id INTEGER);
CREATE TABLE IF NOT EXISTS receipts(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user_id INTEGER, client TEXT, doc TEXT, cell TEXT, lines TEXT NOT NULL);
`);

/* Миграции для баз, созданных версией 1.0: клиентские аккаунты и ключ клиента в журнале и приёмках */
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
if (!hasCol("users", "client")) db.exec("ALTER TABLE users ADD COLUMN client TEXT NOT NULL DEFAULT ''");
for (const table of ["ops", "receipts"]) {
  if (hasCol(table, "ckey")) continue;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ckey TEXT NOT NULL DEFAULT ''`);
  const upd = db.prepare(`UPDATE ${table} SET ckey=? WHERE id=?`);
  db.exec("BEGIN");
  for (const r of db.prepare(`SELECT id, client FROM ${table}`).all()) upd.run(norm(r.client), r.id);
  db.exec("COMMIT");
}
db.exec("CREATE INDEX IF NOT EXISTS ops_ckey ON ops(ckey, id); CREATE INDEX IF NOT EXISTS receipts_ckey ON receipts(ckey, id); CREATE INDEX IF NOT EXISTS stock_ckey ON stock(ckey)");

const Q = {
  userByLogin: db.prepare("SELECT * FROM users WHERE login=?"),
  userById: db.prepare("SELECT * FROM users WHERE id=?"),
  userCount: db.prepare("SELECT COUNT(*) n FROM users"),
  adminCount: db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1"),
  userIns: db.prepare("INSERT INTO users(login,name,role,pass,active,created,client) VALUES(?,?,?,?,1,?,?)"),
  sessIns: db.prepare("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)"),
  sessGet: db.prepare("SELECT s.token,s.expires,u.id,u.login,u.name,u.role,u.active,u.client FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?"),
  sessDelOthers: db.prepare("DELETE FROM sessions WHERE user_id=? AND token<>?"),
  sessTouch: db.prepare("UPDATE sessions SET expires=? WHERE token=?"),
  sessDel: db.prepare("DELETE FROM sessions WHERE token=?"),
  sessDelUser: db.prepare("DELETE FROM sessions WHERE user_id=?"),
  sessPurge: db.prepare("DELETE FROM sessions WHERE expires<?"),
  seen: db.prepare("UPDATE users SET last_seen=? WHERE id=?"),

  stockByKey: db.prepare("SELECT * FROM stock WHERE cell=? AND ckey=? AND akey=?"),
  stockById: db.prepare("SELECT * FROM stock WHERE id=?"),
  stockIns: db.prepare("INSERT INTO stock(cell,client,article,name,qty,ckey,akey,updated) VALUES(?,?,?,?,?,?,?,?)"),
  stockUpd: db.prepare("UPDATE stock SET qty=?, name=?, updated=? WHERE id=?"),
  stockDel: db.prepare("DELETE FROM stock WHERE id=?"),
  stockInCell: db.prepare("SELECT COUNT(*) n FROM stock WHERE cell=?"),

  prodByKey: db.prepare("SELECT * FROM products WHERE ckey=? AND akey=?"),
  prodIns: db.prepare("INSERT INTO products(client,article,name,barcodes,ckey,akey,updated) VALUES(?,?,?,?,?,?,?)"),
  prodUpd: db.prepare("UPDATE products SET name=?, barcodes=?, updated=? WHERE id=?"),
  bcOwner: db.prepare("SELECT p.id,p.client,p.article FROM products p WHERE EXISTS(SELECT 1 FROM json_each(p.barcodes) WHERE value=?)"),

  cellIns: db.prepare("INSERT OR IGNORE INTO cells(cell,zone,created) VALUES(?,?,?)"),
  cellDel: db.prepare("DELETE FROM cells WHERE cell=?"),

  opIns: db.prepare("INSERT INTO ops(ts,type,client,article,name,qty,cell,from_cell,doc,note,user_id,ckey) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"),
  rcIns: db.prepare("INSERT INTO receipts(ts,user_id,client,doc,cell,lines,ckey) VALUES(?,?,?,?,?,?,?)"),
};

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

/* ---------- пароли и сессии ---------- */
function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
}
function checkPass(pw, stored) {
  const [alg, s, h] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(h, "base64");
  const got = crypto.scryptSync(String(pw), Buffer.from(s, "base64"), want.length);
  return crypto.timingSafeEqual(want, got);
}
function newSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  Q.sessIns.run(token, userId, Date.now() + SESSION_DAYS * 864e5);
  setCookie(res, req, token, SESSION_DAYS * 86400);
}
function setCookie(res, req, value, maxAge) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") || req.socket.encrypted;
  res.setHeader("Set-Cookie", `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  try { return m ? decodeURIComponent(m.slice(name.length + 1)) : ""; } catch (e) { return ""; }
}
function sessionUser(req) {
  const token = getCookie(req, "sid");
  if (!token) return null;
  const s = Q.sessGet.get(token);
  if (!s || !s.active || s.expires < Date.now()) return null;
  if (s.expires - Date.now() < (SESSION_DAYS - 1) * 864e5) Q.sessTouch.run(Date.now() + SESSION_DAYS * 864e5, token);
  return { id: s.id, login: s.login, name: s.name, role: s.role, client: s.client || "", token };
}
const isStaff = u => !!u && (u.role === "admin" || u.role === "worker");
/* Защита от подбора паролей. Главный счётчик — по логину: подмена IP или заголовков его не сбрасывает.
   Дополнительный — по адресу. За прокси хостинга (TRUST_PROXY=1, по умолчанию) адрес берётся из последнего
   звена X-Forwarded-For: его дописывает сам прокси, а не браузер. */
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
function clientIp(req) {
  if (TRUST_PROXY) {
    const hops = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || "";
}
const LIMITS = { user: 10, ip: 30, pw: 8 };
const loginFails = new Map();
function rateLimited(key, max) {
  const r = loginFails.get(key);
  return !!r && r.n >= max && Date.now() - r.t < 15 * 60e3;
}
function noteFail(key) {
  const r = loginFails.get(key);
  if (!r || Date.now() - r.t > 15 * 60e3) loginFails.set(key, { n: 1, t: Date.now() });
  else r.n++;
}
setInterval(() => { for (const [k, r] of loginFails) if (Date.now() - r.t > 15 * 60e3) loginFails.delete(k); }, 10 * 60e3).unref();
/* scrypt выполняется и для несуществующих логинов, чтобы по времени ответа нельзя было узнать, какие логины есть */
const DUMMY_HASH = hashPass(crypto.randomBytes(16).toString("hex"));

if (Q.userCount.get().n === 0 && process.env.ADMIN_LOGIN && process.env.ADMIN_PASSWORD) {
  Q.userIns.run(norm(process.env.ADMIN_LOGIN), "Администратор", "admin", hashPass(process.env.ADMIN_PASSWORD), now(), "");
  console.log("Создан администратор", process.env.ADMIN_LOGIN);
}

/* ---------- складские операции (вызываются внутри tx) ---------- */
function log(user, o) {
  Q.opIns.run(now(), o.type, str(o.client), str(o.article), str(o.name), o.qty | 0, str(o.cell), str(o.from), str(o.doc), str(o.note, 500), user ? user.id : null, norm(o.client));
}
function addStock(cell, client, article, name, delta) {
  cell = normCell(cell); client = str(client); article = str(article); name = str(name);
  if (!cell) throw bad("Не указана ячейка");
  if (!article) throw bad("Не указан артикул");
  const row = Q.stockByKey.get(cell, norm(client), norm(article));
  const have = row ? row.qty : 0, qty = have + delta;
  if (qty < 0) throw conflict(`В ячейке ${cell} только ${have} шт. ${article}`);
  if (row) {
    if (qty === 0) Q.stockDel.run(row.id);
    else Q.stockUpd.run(qty, name || row.name, now(), row.id);
  } else if (qty > 0) {
    Q.stockIns.run(cell, client, article, name, qty, norm(client), norm(article), now());
  }
  return { have, qty };
}
function deltaById(id, delta) {
  const row = Q.stockById.get(int(id));
  if (!row) throw conflict("Остатки изменились, пока вы работали. Обновите страницу.");
  const qty = row.qty + delta;
  if (qty < 0) throw conflict(`В ячейке ${row.cell} только ${row.qty} шт. ${row.article}`);
  if (qty === 0) Q.stockDel.run(row.id); else Q.stockUpd.run(qty, row.name, now(), row.id);
  return row;
}
function upsertProduct(client, article, name, barcodes, { replace = false, skipConflicts = false } = {}) {
  client = str(client); article = str(article); name = str(name);
  if (!client || !article) return null;
  const cur = Q.prodByKey.get(norm(client), norm(article));
  const set = new Set(replace || !cur ? [] : JSON.parse(cur.barcodes));
  const skipped = [];
  for (const raw of barcodes || []) {
    const bc = str(raw, 64);
    if (!bc) continue;
    const owner = Q.bcOwner.get(bc);
    if (owner && (!cur || owner.id !== cur.id)) {
      if (skipConflicts) { skipped.push(bc); continue; }
      throw conflict(`Штрихкод ${bc} уже привязан к ${owner.article} (${owner.client})`);
    }
    set.add(bc);
  }
  const bcs = JSON.stringify([...set]);
  if (cur) {
    const nm = name || cur.name;
    if (nm !== cur.name || bcs !== cur.barcodes) Q.prodUpd.run(nm, bcs, now(), cur.id);
  } else {
    Q.prodIns.run(client, article, name, bcs, norm(client), norm(article), now());
  }
  return skipped;
}
const zoneOf = cell => (normCell(cell).split(/[-._/,:]+/)[0] || "");
const addCell = cell => { cell = normCell(cell); if (cell && cell !== BUF) Q.cellIns.run(cell, zoneOf(cell), now()); };

/* ---------- живые обновления (SSE) ---------- */
/* Сотрудники получают, какие разделы изменились. Клиент получает только нейтральное «обновись»
   и только когда изменились его собственные товары — о работе склада с другими клиентами он не узнаёт. */
const streams = new Set();
function broadcast(parts, ckeys) {
  const keys = new Set([...(ckeys || [])].filter(Boolean));
  const staffMsg = `event: change\ndata: ${JSON.stringify({ parts })}\n\n`;
  const clientMsg = `event: change\ndata: ${JSON.stringify({ parts: ["my"] })}\n\n`;
  for (const s of streams) {
    const msg = s.staff ? staffMsg : keys.has(s.ckey) ? clientMsg : null;
    if (!msg) continue;
    try { s.res.write(msg); } catch (e) { streams.delete(s); }
  }
}
function closeStreams(userId) {
  for (const s of streams) if (s.userId === userId) { try { s.res.end(); } catch (e) { } streams.delete(s); }
}
setInterval(() => { for (const s of streams) { try { s.res.write(": ping\n\n"); } catch (e) { streams.delete(s); } } }, 25e3).unref();

/* ---------- маршруты ---------- */
const routes = [];
const route = (method, pathname, access, handler) => routes.push({ method, pathname, access, handler });

route("GET", "/api/health", null, () => ({ ok: true, version: VERSION }));

route("GET", "/api/me", null, ({ user }) => ({
  user: user ? { id: user.id, login: user.login, name: user.name, role: user.role, client: user.role === "client" ? user.client : "" } : null,
  needSetup: Q.userCount.get().n === 0,
  version: VERSION,
}));

route("POST", "/api/setup", null, ({ body, req, res }) => {
  if (Q.userCount.get().n > 0) throw conflict("Администратор уже создан. Войдите со своим логином.");
  const login = norm(body.login), name = str(body.name, 80) || "Администратор";
  if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw bad("Логин: 3–32 латинских буквы, цифры, точка, дефис");
  if (String(body.password || "").length < 6) throw bad("Пароль должен быть не короче 6 символов");
  const r = Q.userIns.run(login, name, "admin", hashPass(body.password), now(), "");
  newSession(res, req, Number(r.lastInsertRowid));
  return { ok: true };
});

route("POST", "/api/login", null, ({ body, req, res }) => {
  const login = norm(body.login);
  const ukey = "user|" + login, ikey = "ip|" + clientIp(req);
  if (rateLimited(ukey, LIMITS.user) || rateLimited(ikey, LIMITS.ip)) throw new HttpError(429, "Слишком много неудачных попыток. Подождите 15 минут.");
  const u = Q.userByLogin.get(login);
  const passOk = checkPass(body.password || "", u ? u.pass : DUMMY_HASH);
  if (!u || !u.active || !passOk) { noteFail(ukey); noteFail(ikey); throw new HttpError(401, "Неверный логин или пароль"); }
  loginFails.delete(ukey);
  newSession(res, req, u.id);
  Q.seen.run(now(), u.id);
  return { ok: true };
});

route("POST", "/api/logout", null, ({ user, req, res }) => {
  if (user) Q.sessDel.run(user.token);
  setCookie(res, req, "", 0);
  return { ok: true };
});

route("GET", "/api/data", "staff", ({ url }) => {
  const parts = (url.searchParams.get("parts") || "stock,products,cells,ops").split(",");
  const out = {};
  if (parts.includes("stock")) out.stock = db.prepare("SELECT id,cell,client,article,name,qty FROM stock").all();
  if (parts.includes("products")) out.products = db.prepare("SELECT id,client,article,name,barcodes FROM products").all().map(p => ({ ...p, barcodes: JSON.parse(p.barcodes) }));
  if (parts.includes("cells")) out.cells = db.prepare("SELECT cell FROM cells").all().map(c => c.cell);
  if (parts.includes("ops")) out.ops = db.prepare("SELECT o.*, u.name AS user_name FROM ops o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 500").all();
  if (parts.includes("receipts")) out.receipts = db.prepare("SELECT r.*, u.name AS user_name FROM receipts r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 50").all().map(r => ({ ...r, lines: JSON.parse(r.lines) }));
  return out;
});

route("GET", "/api/events", "any", ({ req, res, user }) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n");
  const s = { res, userId: user.id, staff: isStaff(user), ckey: user.role === "client" ? norm(user.client) : "" };
  streams.add(s);
  req.on("close", () => streams.delete(s));
  return undefined;
});

/* Личный кабинет клиента: только его товары. Клиент всегда видит свою компанию из аккаунта;
   сотрудник склада может открыть кабинет любого клиента для проверки (?client=...). */
const CLIENT_OPS = "('receive','pick','inventory','adjust')";
route("GET", "/api/my", "any", ({ user, url }) => {
  let client;
  if (user.role === "client") client = user.client;
  else if (isStaff(user)) client = str(url.searchParams.get("client"));
  else throw new HttpError(403, "Нет доступа");
  const ck = norm(client);
  if (!ck) throw bad(user.role === "client" ? "Аккаунт не привязан к клиенту. Обратитесь на склад." : "Выберите клиента");
  const stock = db.prepare("SELECT cell, article, name, qty, updated FROM stock WHERE ckey=?").all(ck);
  const products = db.prepare("SELECT article, name, barcodes FROM products WHERE ckey=?").all(ck).map(p => ({ article: p.article, name: p.name, barcodes: JSON.parse(p.barcodes) }));
  const RC_PAGE = 100;
  const rcBefore = int(url.searchParams.get("rc_before"));
  const rcRows = (rcBefore > 0
    ? db.prepare(`SELECT id, ts, doc, lines FROM receipts WHERE ckey=? AND id<? ORDER BY id DESC LIMIT ${RC_PAGE + 1}`).all(ck, rcBefore)
    : db.prepare(`SELECT id, ts, doc, lines FROM receipts WHERE ckey=? ORDER BY id DESC LIMIT ${RC_PAGE + 1}`).all(ck));
  const receipts = rcRows.slice(0, RC_PAGE).map(r => ({ id: r.id, ts: r.ts, doc: r.doc, lines: JSON.parse(r.lines) }));
  const rcMore = rcRows.length > RC_PAGE;
  if (rcBefore > 0) return { receipts, rcMore };
  const ops = db.prepare(`SELECT id, ts, type, article, name, qty, doc, note FROM ops WHERE ckey=? AND type IN ${CLIENT_OPS} ORDER BY id DESC LIMIT 1000`).all(ck);
  const named = db.prepare("SELECT client FROM stock WHERE ckey=? UNION ALL SELECT client FROM products WHERE ckey=? LIMIT 1").get(ck, ck);
  // момент последнего изменения: строка остатков могла исчезнуть при полном списании, поэтому учитываем и журнал
  const lastOp = (db.prepare("SELECT MAX(ts) t FROM ops WHERE ckey=?").get(ck) || {}).t || "";
  const updated = stock.reduce((m, s) => (s.updated > m ? s.updated : m), lastOp);
  return { client: named ? named.client : client, stock, products, receipts, rcMore, ops, updated };
});

/* Смена своего пароля (любой вошедший пользователь) */
route("POST", "/api/password", "any", ({ body, user }) => {
  const key = "pw|" + user.id;
  if (rateLimited(key, LIMITS.pw)) throw new HttpError(429, "Слишком много попыток. Подождите 15 минут.");
  const u = Q.userById.get(user.id);
  if (!checkPass(body.old || "", u.pass)) { noteFail(key); throw bad("Текущий пароль указан неверно"); }
  if (String(body.password || "").length < 6) throw bad("Новый пароль должен быть не короче 6 символов");
  db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPass(body.password), u.id);
  Q.sessDelOthers.run(u.id, user.token);
  return { ok: true };
});

/* Приёмка */
route("POST", "/api/receive", "staff", ({ body, user }) => {
  const client = str(body.client), doc = str(body.doc), cell = normCell(body.cell) || BUF;
  if (!client) throw bad("Укажите клиента");
  const lines = (Array.isArray(body.lines) ? body.lines : []).map(l => ({
    article: str(l.article), name: str(l.name), barcode: str(l.barcode, 64),
    expected: l.expected == null || l.expected === "" ? null : int(l.expected), got: int(l.got) || 0,
  })).filter(l => l.article);
  if (!lines.some(l => l.got > 0)) throw bad("Нечего принимать");
  if (lines.some(l => l.got < 0)) throw bad("Количество не может быть отрицательным");
  const id = tx(() => {
    addCell(cell);
    for (const l of lines) {
      upsertProduct(client, l.article, l.name, l.barcode ? [l.barcode] : [], { skipConflicts: true });
      if (l.got > 0) {
        addStock(cell, client, l.article, l.name, l.got);
        log(user, { type: "receive", client, article: l.article, name: l.name, qty: l.got, cell, doc });
      }
    }
    return Number(Q.rcIns.run(now(), user.id, client, doc, cell, JSON.stringify(lines), norm(client)).lastInsertRowid);
  });
  broadcast(["stock", "products", "ops", "receipts", "cells"], [norm(client)]);
  return { ok: true, id };
});

/* Размещение и перемещение */
route("POST", "/api/move", "staff", ({ body, user }) => {
  const from = normCell(body.from), to = normCell(body.to);
  if (!to) throw bad("Отсканируйте ячейку назначения");
  if (from === to) throw bad("Ячейки «откуда» и «куда» совпадают");
  const items = (Array.isArray(body.items) ? body.items : []).map(i => ({ id: int(i.id), qty: int(i.qty) })).filter(i => i.qty > 0);
  if (!items.length) throw bad("Ничего не выбрано для перемещения");
  let units = 0;
  const ckeys = new Set();
  tx(() => {
    addCell(to);
    for (const it of items) {
      const row = deltaById(it.id, -it.qty);
      if (row.cell !== from) throw conflict(`Товар ${row.article} лежит не в ${from}, а в ${row.cell}`);
      addStock(to, row.client, row.article, row.name, it.qty);
      log(user, { type: from === BUF ? "putaway" : "move", client: row.client, article: row.article, name: row.name, qty: it.qty, from, cell: to });
      units += it.qty; ckeys.add(row.ckey);
    }
  });
  broadcast(["stock", "ops", "cells"], ckeys);
  return { ok: true, units };
});

/* Сборка */
route("POST", "/api/pick", "staff", ({ body, user }) => {
  const doc = str(body.doc, 500);
  const items = (Array.isArray(body.items) ? body.items : []).map(i => ({ id: int(i.id), qty: int(i.qty) })).filter(i => i.qty > 0);
  if (!items.length) throw bad("Ничего не собрано");
  let units = 0;
  const ckeys = new Set();
  tx(() => {
    for (const it of items) {
      const row = deltaById(it.id, -it.qty);
      log(user, { type: "pick", client: row.client, article: row.article, name: row.name, qty: it.qty, from: row.cell, doc });
      units += it.qty; ckeys.add(row.ckey);
    }
  });
  broadcast(["stock", "ops"], ckeys);
  return { ok: true, units };
});

/* Инвентаризация */
route("POST", "/api/inventory", "staff", ({ body, user }) => {
  const cell = normCell(body.cell);
  if (!cell) throw bad("Не указана ячейка");
  const lines = (Array.isArray(body.lines) ? body.lines : []).map(l => ({ client: str(l.client), article: str(l.article), name: str(l.name), counted: int(l.counted) }))
    .filter(l => l.article && l.counted >= 0);
  let changed = 0;
  const ckeys = new Set();
  tx(() => {
    for (const l of lines) {
      const row = Q.stockByKey.get(cell, norm(l.client), norm(l.article));
      const have = row ? row.qty : 0, d = l.counted - have;
      if (!d) continue;
      const client = row ? row.client : l.client, article = row ? row.article : l.article;
      addStock(cell, client, article, l.name || (row && row.name), d);
      log(user, { type: "inventory", client, article, name: l.name || (row && row.name), qty: d, cell, note: `учёт ${have}, факт ${l.counted}` });
      changed++; ckeys.add(norm(client));
    }
  });
  broadcast(["stock", "ops"], ckeys);
  return { ok: true, changed };
});

/* Ручная корректировка (только администратор) */
route("POST", "/api/adjust", "admin", ({ body, user }) => {
  const note = str(body.note, 200) || "ручная корректировка";
  const ckeys = new Set();
  tx(() => {
    if (body.mode === "delta") {
      ckeys.add(norm(body.client));
      const d = int(body.delta);
      if (!d) throw bad("Укажите количество");
      addStock(body.cell, body.client, body.article, body.name, d);
      log(user, { type: "adjust", client: body.client, article: body.article, name: body.name, qty: d, cell: normCell(body.cell), note });
      addCell(body.cell);
    } else if (body.mode === "set" || body.mode === "delete") {
      const row = Q.stockById.get(int(body.id));
      if (!row) throw conflict("Строка уже изменена. Обновите страницу.");
      const qty = body.mode === "delete" ? 0 : int(body.qty);
      if (!(qty >= 0)) throw bad("Количество не может быть отрицательным");
      const d = qty - row.qty;
      if (!d) return;
      deltaById(row.id, d);
      log(user, { type: "adjust", client: row.client, article: row.article, name: row.name, qty: d, cell: row.cell, note: body.mode === "delete" ? "строка удалена" : note });
      ckeys.add(row.ckey);
    } else throw bad("Неизвестная операция");
  });
  broadcast(["stock", "ops", "cells"], ckeys);
  return { ok: true };
});

/* Загрузка раскладки из Excel (только администратор) */
route("POST", "/api/import-stock", "admin", ({ body, user }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > 20000) throw bad("Слишком большой файл: не больше 20 000 строк за раз");
  let ok = 0, units = 0, skippedBc = 0;
  const ckeys = new Set(), doc = `раскладка «${str(body.file, 120)}»`;
  tx(() => {
    for (const r of rows) {
      const qty = int(r.qty);
      if (!normCell(r.cell) || !str(r.article) || !(qty > 0)) continue;
      addStock(r.cell, r.client, r.article, r.name, qty);
      addCell(r.cell);
      skippedBc += (upsertProduct(r.client, r.article, r.name, r.barcode ? [r.barcode] : [], { skipConflicts: true }) || []).length;
      // каждая строка — отдельная запись журнала, чтобы клиент видел, откуда взялся товар
      log(user, { type: "adjust", client: r.client, article: r.article, name: r.name, qty, cell: normCell(r.cell), doc, note: "загрузка раскладки" });
      ok++; units += qty; ckeys.add(norm(r.client));
    }
  });
  broadcast(["stock", "products", "ops", "cells"], ckeys);
  return { ok, units, skippedBc };
});

/* Справочник товаров */
route("POST", "/api/products", "staff", ({ body }) => {
  const client = str(body.client), article = str(body.article);
  if (!client || !article) throw bad("Укажите клиента и артикул");
  const bcs = (Array.isArray(body.barcodes) ? body.barcodes : String(body.barcodes || "").split(/[,;\s]+/)).map(b => str(b, 64)).filter(Boolean);
  tx(() => upsertProduct(client, article, body.name, bcs, { replace: true }));
  broadcast(["products"], [norm(client)]);
  return { ok: true };
});
route("POST", "/api/products/bulk", "staff", ({ body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  let ok = 0, skippedBc = 0;
  const ckeys = new Set();
  tx(() => {
    for (const r of rows) {
      const s = upsertProduct(r.client, r.article, r.name, r.barcode ? String(r.barcode).split(/[,;\s]+/) : [], { skipConflicts: true });
      if (s) { ok++; skippedBc += s.length; ckeys.add(norm(r.client)); }
    }
  });
  broadcast(["products"], ckeys);
  return { ok, skippedBc };
});
route("POST", "/api/products/from-stock", "staff", () => {
  let ok = 0;
  const ckeys = new Set();
  tx(() => {
    for (const r of db.prepare("SELECT DISTINCT client, article, name FROM stock s WHERE NOT EXISTS(SELECT 1 FROM products p WHERE p.ckey=s.ckey AND p.akey=s.akey)").all()) {
      if (!Q.prodByKey.get(norm(r.client), norm(r.article))) { upsertProduct(r.client, r.article, r.name, []); ok++; ckeys.add(norm(r.client)); }
    }
  });
  broadcast(["products"], ckeys);
  return { ok };
});

/* Ячейки */
route("POST", "/api/cells", "staff", ({ body }) => {
  const list = (Array.isArray(body.cells) ? body.cells : []).map(normCell).filter(Boolean);
  if (list.length > 5000) throw bad("Не больше 5000 ячеек за раз");
  tx(() => list.forEach(addCell));
  broadcast(["cells"]);
  return { ok: list.length };
});
route("POST", "/api/cells/delete", "admin", ({ body }) => {
  let n = 0;
  tx(() => {
    for (const c of (Array.isArray(body.cells) ? body.cells : []).map(normCell)) {
      if (Q.stockInCell.get(c).n === 0) n += Number(Q.cellDel.run(c).changes);
    }
  });
  broadcast(["cells"]);
  return { ok: n };
});

/* Сотрудники */
const ROLES = ["admin", "worker", "client"];
route("GET", "/api/users", "admin", () => ({
  users: db.prepare("SELECT id,login,name,role,client,active,created,last_seen FROM users ORDER BY active DESC, role='client', name").all(),
}));
route("POST", "/api/users", "admin", ({ body }) => {
  const login = norm(body.login), name = str(body.name, 80), role = ROLES.includes(body.role) ? body.role : "worker";
  const client = role === "client" ? str(body.client, 120) : "";
  if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw bad("Логин: 3–32 латинских буквы, цифры, точка, дефис");
  if (!name) throw bad("Укажите имя");
  if (role === "client" && !client) throw bad("Укажите, к какому клиенту относится аккаунт");
  if (String(body.password || "").length < 6) throw bad("Пароль должен быть не короче 6 символов");
  if (Q.userByLogin.get(login)) throw conflict(`Логин ${login} уже занят`);
  Q.userIns.run(login, name, role, hashPass(body.password), now(), client);
  return { ok: true };
});
route("POST", "/api/users/update", "admin", ({ body, user }) => {
  const u = Q.userById.get(int(body.id));
  if (!u) throw bad("Пользователь не найден");
  const name = body.name != null ? str(body.name, 80) || u.name : u.name;
  const role = ROLES.includes(body.role) ? body.role : u.role;
  const active = body.active != null ? (body.active ? 1 : 0) : u.active;
  const client = role === "client" ? (body.client != null ? str(body.client, 120) : u.client) : "";
  if (role === "client" && !client) throw bad("Укажите, к какому клиенту относится аккаунт");
  if (u.role === "admin" && u.active && (role !== "admin" || !active) && Q.adminCount.get().n <= 1) throw conflict("Нельзя убрать последнего администратора");
  if (u.id === user.id && !active) throw conflict("Нельзя отключить самого себя");
  tx(() => {
    db.prepare("UPDATE users SET name=?, role=?, active=?, client=? WHERE id=?").run(name, role, active, client, u.id);
    if (body.password) {
      if (String(body.password).length < 6) throw bad("Пароль должен быть не короче 6 символов");
      db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPass(body.password), u.id);
    }
    if (!active || body.password) Q.sessDelUser.run(u.id);
  });
  // открытые потоки событий помнят роль и компанию — после изменения доступа переподключаем пользователя
  if (!active || body.password || role !== u.role || client !== u.client) closeStreams(u.id);
  return { ok: true };
});

/* Резервная копия базы */
function makeBackup(file) {
  try { fs.unlinkSync(file); } catch (e) { }
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
route("GET", "/api/backup", "admin", ({ res }) => {
  const file = path.join(DATA_DIR, "backups", "download.db");
  makeBackup(file);
  const name = `sklad-${now().slice(0, 10)}.db`;
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"`, "Content-Length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
  return undefined;
});
function dailyBackup() {
  try {
    const dir = path.join(DATA_DIR, "backups");
    const file = path.join(dir, `auto-${now().slice(0, 10)}.db`);
    if (!fs.existsSync(file)) makeBackup(file);
    const autos = fs.readdirSync(dir).filter(f => f.startsWith("auto-")).sort();
    autos.slice(0, Math.max(0, autos.length - 14)).forEach(f => fs.unlinkSync(path.join(dir, f)));
    Q.sessPurge.run(Date.now());
  } catch (e) { console.error("Резервная копия не создана:", e.message); }
}
setTimeout(dailyBackup, 60e3).unref();
setInterval(dailyBackup, 3600e3).unref();

/* ---------- статика ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const cache = new Map();
function staticFile(rel) {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit;
  const body = fs.readFileSync(file);
  const ext = path.extname(file);
  const compressible = [".html", ".js", ".css", ".json", ".svg", ".webmanifest"].includes(ext);
  const entry = { mtime, body, gz: compressible ? zlib.gzipSync(body) : null, type: TYPES[ext] || "application/octet-stream", etag: `"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`, rel };
  cache.set(file, entry);
  return entry;
}
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ""); }
  catch (e) { return send(res, 400, { error: "Некорректный адрес" }); }
  let f = rel ? staticFile(rel) : null;
  if (!f) f = staticFile("index.html");
  const headers = {
    "Content-Type": f.type, ETag: f.etag, Vary: "Accept-Encoding",
    "Cache-Control": f.rel.startsWith("vendor/") || f.rel.startsWith("fonts/") ? "public, max-age=2592000" : "no-cache",
  };
  if (req.headers["if-none-match"] === f.etag) { res.writeHead(304, headers); return res.end(); }
  if (f.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) { headers["Content-Encoding"] = "gzip"; res.writeHead(200, headers); return res.end(f.gz); }
  res.writeHead(200, headers); res.end(f.body);
}

/* ---------- сервер ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 20e6) { reject(new HttpError(413, "Слишком большой запрос")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(bad("Некорректный запрос")); }
    });
    req.on("error", reject);
  });
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  const url = new URL(req.url, "http://x");
  try {
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Метод не поддерживается" });
      return serveStatic(req, res, url.pathname);
    }
    const r = routes.find(x => x.method === req.method && x.pathname === url.pathname);
    if (!r) return send(res, 404, { error: "Не найдено" });
    // SameSite=Lax cookie + обязательный JSON не дают чужому сайту отправить операцию от имени сотрудника
    if (req.method === "POST" && !/application\/json/.test(req.headers["content-type"] || "")) return send(res, 415, { error: "Ожидается JSON" });
    const user = sessionUser(req);
    if (r.access && !user) return send(res, 401, { error: "Нужно войти" });
    if (r.access === "admin" && user.role !== "admin") return send(res, 403, { error: "Это доступно только администратору" });
    if (r.access === "staff" && !isStaff(user)) return send(res, 403, { error: "Это доступно только сотрудникам склада" });
    const body = req.method === "POST" ? await readBody(req) : {};
    const out = await r.handler({ req, res, url, body, user });
    if (out !== undefined) send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "Ошибка на сервере. Попробуйте ещё раз." });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Склад «Дело в коробке» ${VERSION}: порт ${PORT}, данные в ${DATA_DIR}`));
  const stop = () => { server.close(); try { db.close(); } catch (e) { } process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
module.exports = { server, db };

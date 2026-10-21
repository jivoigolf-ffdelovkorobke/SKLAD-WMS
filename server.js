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

/* Учёт услуг (версия 1.2): тарифы, индивидуальные цены клиентов, начисления, счета, реквизиты */
db.exec(`
CREATE TABLE IF NOT EXISTS services(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'manual', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS client_prices(ckey TEXT NOT NULL, service_id INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY(ckey, service_id));
CREATE TABLE IF NOT EXISTS invoices(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, client TEXT NOT NULL, ckey TEXT NOT NULL,
  period_from TEXT NOT NULL, period_to TEXT NOT NULL, total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued', user_id INTEGER, created TEXT NOT NULL, paid TEXT);
CREATE TABLE IF NOT EXISTS charges(
  id INTEGER PRIMARY KEY, client TEXT NOT NULL, ckey TEXT NOT NULL, service_id INTEGER NOT NULL,
  qty REAL NOT NULL, price REAL NOT NULL, amount REAL NOT NULL, day TEXT NOT NULL,
  period_from TEXT, period_to TEXT, note TEXT NOT NULL DEFAULT '', invoice_id INTEGER, user_id INTEGER, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS charges_ckey ON charges(ckey, invoice_id, day);
CREATE INDEX IF NOT EXISTS invoices_ckey ON invoices(ckey, id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
`);
/* kind: receive и pick начисляются сами при приёмке и сборке, storage считается по дням при выставлении счёта,
   manual добавляют вручную. Цены — стартовые, их меняют в разделе «Счета → Тарифы». */
const DEFAULT_SERVICES = [
  ["RECEIVE", "Приёмка товара", "шт", 5, "receive"],
  ["PICK", "Сборка и отгрузка", "шт", 15, "pick"],
  ["STORAGE", "Хранение", "шт·сут", 0.5, "storage"],
  ["PACK", "Упаковка", "шт", 10, "manual"],
  ["LABEL", "Маркировка (этикетка)", "шт", 5, "manual"],
  ["DELIVERY", "Доставка на склад маркетплейса", "рейс", 3500, "manual"],
];
if (db.prepare("SELECT COUNT(*) n FROM services").get().n === 0) {
  const ins = db.prepare("INSERT INTO services(code,name,unit,price,kind) VALUES(?,?,?,?,?)");
  for (const s of DEFAULT_SERVICES) ins.run(...s);
}
const SETTINGS_KEYS = ["company_name", "company_inn", "company_kpp", "company_ogrn", "company_address", "director", "accountant",
  "bank_name", "bank_bik", "bank_account", "bank_corr_account", "vat_note", "dadata_key", "stamp_png", "sign_png"];
/* печать и подпись — картинки PNG, ключ DaData — секрет: клиентам и в счета он не попадает */
const IMAGE_KEYS = ["stamp_png", "sign_png"], SECRET_KEYS = ["dadata_key"];
db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('vat_note','Без НДС')").run();

/* Версия 1.3: права сотрудников, оклад за смену, графики, штрафы и премии; карточки клиентов с подразделениями;
   несколько расчётных счетов с привязкой к клиенту и подразделению; снимок реквизитов в каждом счёте */
{
  const permsAdded = !hasCol("users", "perms");
  for (const [col, def] of [["perms", "TEXT NOT NULL DEFAULT ''"], ["rate", "REAL NOT NULL DEFAULT 0"], ["dept", "TEXT NOT NULL DEFAULT ''"],
    ["manage_depts", "TEXT NOT NULL DEFAULT ''"], ["sub_id", "INTEGER"], ["can_change_pw", "INTEGER NOT NULL DEFAULT 1"]])
    if (!hasCol("users", col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
  // кладовщики из прошлых версий сохраняют всё, что умели
  if (permsAdded) db.exec("UPDATE users SET perms='ops,stock,services' WHERE role='worker'");
  for (const [col, def] of [["sub_id", "INTEGER"], ["bank_id", "INTEGER"], ["doc", "TEXT"]])
    if (!hasCol("invoices", col)) db.exec(`ALTER TABLE invoices ADD COLUMN ${col} ${def}`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS shifts(user_id INTEGER NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, rate REAL NOT NULL DEFAULT 0,
  set_by INTEGER, updated TEXT NOT NULL, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS fines(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fine',
  amount REAL NOT NULL, reason TEXT NOT NULL DEFAULT '', created_by INTEGER, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS fines_user ON fines(user_id, day);
CREATE INDEX IF NOT EXISTS ops_user ON ops(user_id, ts);
CREATE TABLE IF NOT EXISTS clients(ckey TEXT PRIMARY KEY, name TEXT NOT NULL, inn TEXT NOT NULL DEFAULT '', kpp TEXT NOT NULL DEFAULT '',
  ogrn TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', bank_id INTEGER, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS client_subs(id INTEGER PRIMARY KEY, ckey TEXT NOT NULL, name TEXT NOT NULL, bank_id INTEGER, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bank_accounts(id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', bank_name TEXT NOT NULL, bik TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL, corr_account TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);
`);
// расчётный счёт из реквизитов версии 1.2 становится основным
if (db.prepare("SELECT COUNT(*) n FROM bank_accounts").get().n === 0) {
  const s = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map(r => [r.key, r.value]));
  if (s.bank_account) db.prepare("INSERT INTO bank_accounts(title,bank_name,bik,account,corr_account,is_default,created) VALUES(?,?,?,?,?,1,?)")
    .run("Основной", s.bank_name || "", s.bank_bik || "", s.bank_account, s.bank_corr_account || "", new Date().toISOString());
}

const Q = {
  userByLogin: db.prepare("SELECT * FROM users WHERE login=?"),
  userById: db.prepare("SELECT * FROM users WHERE id=?"),
  userCount: db.prepare("SELECT COUNT(*) n FROM users"),
  adminCount: db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1"),
  userIns: db.prepare("INSERT INTO users(login,name,role,pass,active,created,client) VALUES(?,?,?,?,1,?,?)"),
  sessIns: db.prepare("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)"),
  sessGet: db.prepare("SELECT s.token,s.expires,u.id,u.login,u.name,u.role,u.active,u.client,u.perms,u.dept,u.manage_depts,u.sub_id,u.can_change_pw,u.rate FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?"),
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
  return { id: s.id, login: s.login, name: s.name, role: s.role, client: s.client || "", token, perms: s.perms || "", dept: s.dept || "",
    manage_depts: s.manage_depts || "", sub_id: s.sub_id || null, can_change_pw: s.can_change_pw, rate: s.rate || 0 };
}
const isStaff = u => !!u && (u.role === "admin" || u.role === "worker");
/* Права сотрудника назначает администратор. ops — складские операции; stock — остатки, товары, ячейки, журнал;
   services — начисления услуг; team — руководитель: графики, штрафы и премии своих подразделений. */
const PERMS = ["ops", "stock", "services", "team"];
const permsOf = u => !u ? [] : u.role === "admin" ? PERMS : u.role === "worker" ? String(u.perms || "").split(",").filter(p => PERMS.includes(p)) : [];
const can = (u, p) => permsOf(u).includes(p);
const cleanPerms = v => [...new Set((Array.isArray(v) ? v : String(v || "").split(",")).map(String).filter(p => PERMS.includes(p)))].join(",");
const deptList = v => [...new Set((Array.isArray(v) ? v : String(v || "").split(",")).map(s => str(s, 60)).filter(Boolean))];
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
  user: user ? { id: user.id, login: user.login, name: user.name, role: user.role, client: user.role === "client" ? user.client : "",
    perms: permsOf(user), dept: user.dept, can_change_pw: user.role !== "client" || !!user.can_change_pw } : null,
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

route("GET", "/api/data", "perm:ops|stock", ({ url }) => {
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
  else if (can(user, "stock")) client = str(url.searchParams.get("client"));
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
  if (user.role === "client" && !user.can_change_pw) throw new HttpError(403, "Пароль выдаёт склад. Чтобы сменить его, обратитесь к администратору.");
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
route("POST", "/api/receive", "perm:ops", ({ body, user }) => {
  const client = str(body.client), doc = str(body.doc), cell = normCell(body.cell) || BUF;
  if (!client) throw bad("Укажите клиента");
  const lines = (Array.isArray(body.lines) ? body.lines : []).map(l => ({
    article: str(l.article), name: str(l.name), barcode: str(l.barcode, 64),
    expected: l.expected == null || l.expected === "" ? null : int(l.expected), got: int(l.got) || 0,
    cell: normCell(l.cell) || "",
  })).filter(l => l.article);
  if (!lines.some(l => l.got > 0)) throw bad("Нечего принимать");
  if (lines.some(l => l.got < 0)) throw bad("Количество не может быть отрицательным");
  const id = tx(() => {
    addCell(cell);
    let units = 0;
    for (const l of lines) {
      upsertProduct(client, l.article, l.name, l.barcode ? [l.barcode] : [], { skipConflicts: true });
      if (l.got > 0) {
        // строка из списка с ячейкой — товар сразу ложится в неё, без зоны приёмки
        const to = l.cell || cell;
        if (to !== cell) addCell(to);
        addStock(to, client, l.article, l.name, l.got);
        log(user, { type: "receive", client, article: l.article, name: l.name, qty: l.got, cell: to, doc });
        units += l.got;
      }
    }
    autoCharge(user, "receive", client, units, doc ? `Приёмка ${doc}` : "Приёмка");
    return Number(Q.rcIns.run(now(), user.id, client, doc, cell, JSON.stringify(lines), norm(client)).lastInsertRowid);
  });
  broadcast(["stock", "products", "ops", "receipts", "cells", "billing"], [norm(client)]);
  return { ok: true, id };
});

/* Размещение и перемещение */
route("POST", "/api/move", "perm:ops", ({ body, user }) => {
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
route("POST", "/api/pick", "perm:ops", ({ body, user }) => {
  const doc = str(body.doc, 500);
  const items = (Array.isArray(body.items) ? body.items : []).map(i => ({ id: int(i.id), qty: int(i.qty) })).filter(i => i.qty > 0);
  if (!items.length) throw bad("Ничего не собрано");
  let units = 0;
  const ckeys = new Set();
  tx(() => {
    const perClient = new Map();
    for (const it of items) {
      const row = deltaById(it.id, -it.qty);
      log(user, { type: "pick", client: row.client, article: row.article, name: row.name, qty: it.qty, from: row.cell, doc });
      units += it.qty; ckeys.add(row.ckey);
      const pc = perClient.get(row.ckey) || { client: row.client, units: 0 };
      pc.units += it.qty; perClient.set(row.ckey, pc);
    }
    for (const pc of perClient.values()) autoCharge(user, "pick", pc.client, pc.units, doc ? `Сборка ${doc.slice(0, 120)}` : "Сборка");
  });
  broadcast(["stock", "ops", "billing"], ckeys);
  return { ok: true, units };
});

/* Инвентаризация */
route("POST", "/api/inventory", "perm:ops", ({ body, user }) => {
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
route("POST", "/api/products", "perm:stock", ({ body }) => {
  const client = str(body.client), article = str(body.article);
  if (!client || !article) throw bad("Укажите клиента и артикул");
  const bcs = (Array.isArray(body.barcodes) ? body.barcodes : String(body.barcodes || "").split(/[,;\s]+/)).map(b => str(b, 64)).filter(Boolean);
  tx(() => upsertProduct(client, article, body.name, bcs, { replace: true }));
  broadcast(["products"], [norm(client)]);
  return { ok: true };
});
route("POST", "/api/products/bulk", "perm:stock", ({ body }) => {
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
route("POST", "/api/products/from-stock", "perm:stock", () => {
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
route("POST", "/api/cells", "perm:stock|ops", ({ body }) => {
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
const USER_COLS = "id,login,name,role,client,active,created,last_seen,perms,rate,dept,manage_depts,sub_id,can_change_pw";
route("GET", "/api/users", "admin", () => ({
  users: db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY active DESC, role='client', name`).all(),
  perms: PERMS,
}));
function parseRate(v) {
  if (v == null || String(v).trim() === "") return 0;
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw bad("Оклад за смену должен быть числом от 0");
  return Math.round(n * 100) / 100;
}
/* подразделение клиента должно принадлежать этому клиенту */
function checkSub(client, subId) {
  if (subId == null || subId === "") return null;
  const sub = db.prepare("SELECT * FROM client_subs WHERE id=?").get(int(subId));
  if (!sub || sub.ckey !== norm(client)) throw bad("Подразделение не относится к этому клиенту");
  return sub.id;
}
route("POST", "/api/users", "admin", ({ body }) => {
  const login = norm(body.login), name = str(body.name, 80), role = ROLES.includes(body.role) ? body.role : "worker";
  const client = role === "client" ? str(body.client, 120) : "";
  if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw bad("Логин: 3–32 латинских буквы, цифры, точка, дефис");
  if (!name) throw bad("Укажите имя");
  if (role === "client" && !client) throw bad("Укажите, к какому клиенту относится аккаунт");
  if (String(body.password || "").length < 6) throw bad("Пароль должен быть не короче 6 символов");
  if (Q.userByLogin.get(login)) throw conflict(`Логин ${login} уже занят`);
  const subId = role === "client" ? checkSub(client, body.sub_id) : null;
  const id = tx(() => {
    const r = Q.userIns.run(login, name, role, hashPass(body.password), now(), client);
    const uid = Number(r.lastInsertRowid);
    db.prepare("UPDATE users SET perms=?, rate=?, dept=?, manage_depts=?, sub_id=?, can_change_pw=? WHERE id=?").run(
      role === "worker" ? cleanPerms(body.perms ?? "ops,stock,services") : "",
      role === "client" ? 0 : parseRate(body.rate), role === "client" ? "" : str(body.dept, 60),
      role === "worker" ? deptList(body.manage_depts).join(",") : "", subId,
      // клиенту по умолчанию пароль выдаёт склад, и администратор всегда знает действующий пароль
      role === "client" ? (body.can_change_pw ? 1 : 0) : 1, uid);
    return uid;
  });
  return { ok: true, id };
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
  const perms = role === "worker" ? (body.perms != null ? cleanPerms(body.perms) : (u.role === "worker" ? u.perms : "ops,stock,services")) : "";
  const rate = role === "client" ? 0 : body.rate != null ? parseRate(body.rate) : u.rate;
  const dept = role === "client" ? "" : body.dept != null ? str(body.dept, 60) : u.dept;
  const manage = role === "worker" ? (body.manage_depts != null ? deptList(body.manage_depts).join(",") : u.manage_depts) : "";
  const subId = role === "client" ? (body.sub_id !== undefined ? checkSub(client, body.sub_id) : (norm(client) === norm(u.client) ? u.sub_id : null)) : null;
  const canPw = role === "client" ? (body.can_change_pw != null ? (body.can_change_pw ? 1 : 0) : (u.role === "client" ? u.can_change_pw : 0)) : 1;
  tx(() => {
    db.prepare("UPDATE users SET name=?, role=?, active=?, client=?, perms=?, rate=?, dept=?, manage_depts=?, sub_id=?, can_change_pw=? WHERE id=?")
      .run(name, role, active, client, perms, rate, dept, manage, subId, canPw, u.id);
    if (body.password) {
      if (String(body.password).length < 6) throw bad("Пароль должен быть не короче 6 символов");
      db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPass(body.password), u.id);
    }
    if (!active || body.password) Q.sessDelUser.run(u.id);
  });
  // открытые потоки событий помнят роль и компанию — после изменения доступа переподключаем пользователя
  if (!active || body.password || role !== u.role || client !== u.client || perms !== u.perms) closeStreams(u.id);
  return { ok: true };
});

/* ---------- команда: график смен, штрафы и премии, зарплата ---------- */
function parseMonth(v) {
  const m = String(v || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad("Неверный месяц");
  const from = m + "-01";
  const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0));
  return { month: m, from, to: d.toISOString().slice(0, 10), days: d.getUTCDate() };
}
/* кого видит и кем управляет: администратор — всеми сотрудниками, руководитель — своими подразделениями (себя не правит) */
function teamOf(user) {
  const all = db.prepare("SELECT id,login,name,role,dept,rate,active FROM users WHERE role IN ('admin','worker') ORDER BY name").all();
  if (user.role === "admin") return all;
  if (!can(user, "team")) return [];
  const depts = new Set(deptList(user.manage_depts).map(norm));
  if (!depts.size && user.dept) depts.add(norm(user.dept));
  return all.filter(u => u.id !== user.id && u.role === "worker" && depts.has(norm(u.dept)));
}
function teamMember(user, id) {
  const m = teamOf(user).find(u => u.id === int(id));
  if (!m) throw new HttpError(403, "Этот сотрудник не в вашем подразделении");
  return m;
}
/* рабочие сутки — по московскому времени; ts хранится в UTC */
const dayStartUtc = day => new Date(Date.parse(day + "T00:00:00Z") - DAY_SHIFT).toISOString();
function activityOf(ids, from, to) {
  const out = {};
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT user_id, ts FROM ops WHERE user_id IN (${ids.map(() => "?").join(",")}) AND ts>=? AND ts<?`)
    .all(...ids, dayStartUtc(from), dayStartUtc(addDays(to, 1)));
  for (const r of rows) { const d = dayOf(r.ts); (out[r.user_id] ||= {})[d] = (out[r.user_id][d] || 0) + 1; }
  return out;
}
function salaryOf(ids, from, to) {
  const res = new Map(ids.map(id => [id, { user_id: id, done: 0, base: 0, fines: 0, bonuses: 0, total: 0 }]));
  if (!ids.length) return [];
  const q = ids.map(() => "?").join(",");
  for (const s of db.prepare(`SELECT user_id, rate FROM shifts WHERE status='done' AND user_id IN (${q}) AND day BETWEEN ? AND ?`).all(...ids, from, to)) {
    const r = res.get(s.user_id); r.done++; r.base = money(r.base + s.rate);
  }
  for (const f of db.prepare(`SELECT user_id, kind, amount FROM fines WHERE user_id IN (${q}) AND day BETWEEN ? AND ?`).all(...ids, from, to)) {
    const r = res.get(f.user_id); if (f.kind === "bonus") r.bonuses = money(r.bonuses + f.amount); else r.fines = money(r.fines + f.amount);
  }
  for (const r of res.values()) r.total = money(r.base + r.bonuses - r.fines);
  return [...res.values()];
}
const FINE_SELECT = "SELECT f.id, f.user_id, f.day, f.kind, f.amount, f.reason, f.created, u.name AS created_by_name FROM fines f LEFT JOIN users u ON u.id=f.created_by";
route("GET", "/api/team", "perm:team", ({ user, url }) => {
  const m = parseMonth(url.searchParams.get("month"));
  const team = teamOf(user), ids = team.map(u => u.id);
  const q = ids.map(() => "?").join(",") || "NULL";
  return {
    ...m, users: team,
    shifts: ids.length ? db.prepare(`SELECT user_id, day, status, rate FROM shifts WHERE user_id IN (${q}) AND day BETWEEN ? AND ?`).all(...ids, m.from, m.to) : [],
    fines: ids.length ? db.prepare(`${FINE_SELECT} WHERE f.user_id IN (${q}) AND f.day BETWEEN ? AND ? ORDER BY f.day DESC, f.id DESC`).all(...ids, m.from, m.to) : [],
    activity: activityOf(ids, m.from, m.to),
    salary: salaryOf(ids, m.from, m.to),
    depts: [...new Set(db.prepare("SELECT dept FROM users WHERE dept<>''").all().map(r => r.dept))].sort(),
    today: dayOf(now()),
  };
});
const SHIFT_ST = ["plan", "done", "absent"];
function setShift(user, member, day, status) {
  if (!status) { db.prepare("DELETE FROM shifts WHERE user_id=? AND day=?").run(member.id, day); return; }
  if (!SHIFT_ST.includes(status)) throw bad("Неизвестный статус смены");
  const rate = db.prepare("SELECT rate FROM users WHERE id=?").get(member.id).rate || 0;
  db.prepare(`INSERT INTO shifts(user_id,day,status,rate,set_by,updated) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,day) DO UPDATE SET status=excluded.status, rate=CASE WHEN excluded.status='done' AND shifts.status<>'done' THEN excluded.rate ELSE shifts.rate END,
    set_by=excluded.set_by, updated=excluded.updated`).run(member.id, day, status, rate, user.id, now());
}
route("POST", "/api/team/shift", "perm:team", ({ body, user }) => {
  const member = teamMember(user, body.user_id), day = parseDay(body.day, "Дата");
  tx(() => setShift(user, member, day, str(body.status, 10)));
  broadcast(["team"]);
  return { ok: true };
});
/* заполнить план на месяц: 5/2 — будни; 2/2 — два через два, начиная с даты start. Отработанные и прогулы не трогаем. */
route("POST", "/api/team/pattern", "perm:team", ({ body, user }) => {
  const member = teamMember(user, body.user_id), m = parseMonth(body.month), pattern = String(body.pattern || "");
  if (!["5/2", "2/2", "clear"].includes(pattern)) throw bad("Неизвестный график");
  const start = pattern === "2/2" ? parseDay(body.start || m.from, "Начало") : m.from;
  let n = 0;
  tx(() => {
    for (let d = m.from; d <= m.to; d = addDays(d, 1)) {
      const cur = db.prepare("SELECT status FROM shifts WHERE user_id=? AND day=?").get(member.id, d);
      if (cur && cur.status !== "plan") continue;
      let work;
      if (pattern === "5/2") { const wd = new Date(d + "T00:00:00Z").getUTCDay(); work = wd >= 1 && wd <= 5; }
      else if (pattern === "2/2") { const k = Math.round((Date.parse(d) - Date.parse(start)) / 864e5); work = ((k % 4) + 4) % 4 < 2; }
      else work = false;
      if (work) { setShift(user, member, d, "plan"); n++; }
      else if (cur) db.prepare("DELETE FROM shifts WHERE user_id=? AND day=?").run(member.id, d);
    }
  });
  broadcast(["team"]);
  return { ok: true, planned: n };
});
/* отметить отработанными прошедшие дни, в которые сотрудник проводил операции в системе */
route("POST", "/api/team/autofill", "perm:team", ({ body, user }) => {
  const m = parseMonth(body.month), today = dayOf(now());
  const team = teamOf(user), act = activityOf(team.map(u => u.id), m.from, m.to);
  let n = 0;
  tx(() => {
    for (const u of team) for (const [day, cnt] of Object.entries(act[u.id] || {})) {
      if (day > today || !cnt) continue;
      const cur = db.prepare("SELECT status FROM shifts WHERE user_id=? AND day=?").get(u.id, day);
      if (cur && cur.status !== "plan") continue;
      setShift(user, u, day, "done"); n++;
    }
  });
  broadcast(["team"]);
  return { ok: true, marked: n };
});
route("POST", "/api/team/fine", "perm:team", ({ body, user }) => {
  const member = teamMember(user, body.user_id), day = parseDay(body.day, "Дата");
  const kind = body.kind === "bonus" ? "bonus" : "fine";
  const amount = Number(String(body.amount ?? "").replace(",", "."));
  if (!(amount > 0) || amount > 1e7) throw bad("Укажите сумму больше нуля");
  const reason = str(body.reason, 300);
  if (!reason) throw bad("Укажите причину");
  db.prepare("INSERT INTO fines(user_id,day,kind,amount,reason,created_by,created) VALUES(?,?,?,?,?,?,?)").run(member.id, day, kind, money(amount), reason, user.id, now());
  broadcast(["team"]);
  return { ok: true };
});
route("POST", "/api/team/fine/delete", "perm:team", ({ body, user }) => {
  const f = db.prepare("SELECT * FROM fines WHERE id=?").get(int(body.id));
  if (!f) throw bad("Запись не найдена");
  teamMember(user, f.user_id);
  db.prepare("DELETE FROM fines WHERE id=?").run(f.id);
  broadcast(["team"]);
  return { ok: true };
});
/* личный кабинет сотрудника: свой график, зарплата, штрафы и премии, свои операции за месяц */
route("GET", "/api/cabinet", "staff", ({ user, url }) => {
  const m = parseMonth(url.searchParams.get("month"));
  const ops = db.prepare("SELECT id, ts, type, client, article, name, qty, cell, from_cell, doc FROM ops WHERE user_id=? AND ts>=? AND ts<? ORDER BY id DESC LIMIT 2000")
    .all(user.id, dayStartUtc(m.from), dayStartUtc(addDays(m.to, 1)));
  return {
    ...m, name: user.name, dept: user.dept, rate: user.rate, today: dayOf(now()),
    shifts: db.prepare("SELECT day, status, rate FROM shifts WHERE user_id=? AND day BETWEEN ? AND ?").all(user.id, m.from, m.to),
    fines: db.prepare(`${FINE_SELECT} WHERE f.user_id=? AND f.day BETWEEN ? AND ? ORDER BY f.day DESC, f.id DESC`).all(user.id, m.from, m.to),
    salary: salaryOf([user.id], m.from, m.to)[0],
    ops: ops.map(o => ({ ...o, day: dayOf(o.ts) })),
  };
});

/* ---------- клиенты: карточки, подразделения, расчётные счета ---------- */
const BANK_COLS = "id,title,bank_name,bik,account,corr_account,is_default,active";
route("GET", "/api/clients", "admin", () => {
  const cards = new Map(db.prepare("SELECT * FROM clients").all().map(c => [c.ckey, { ...c, carded: true }]));
  // клиенты, которые есть в остатках и товарах, но ещё без карточки
  for (const r of db.prepare("SELECT client FROM stock UNION SELECT client FROM products UNION SELECT client FROM users WHERE role='client'").all()) {
    const k = norm(r.client);
    if (k && !cards.has(k)) cards.set(k, { ckey: k, name: str(r.client).replace(/\s+/g, " "), inn: "", kpp: "", ogrn: "", address: "", bank_id: null, carded: false });
  }
  const subs = db.prepare("SELECT id, ckey, name, bank_id FROM client_subs ORDER BY name").all();
  const accounts = db.prepare("SELECT id, login, name, client, sub_id, active, can_change_pw, last_seen FROM users WHERE role='client' ORDER BY name").all();
  const list = [...cards.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")).map(c => ({
    ...c, subs: subs.filter(s => s.ckey === c.ckey), accounts: accounts.filter(a => norm(a.client) === c.ckey),
  }));
  return { clients: list, banks: db.prepare(`SELECT ${BANK_COLS} FROM bank_accounts WHERE active=1 ORDER BY is_default DESC, id`).all() };
});
const digits = (v, n, label) => { const s = String(v || "").replace(/\s+/g, ""); if (s && !new RegExp(`^\\d{${n.join("}$|^\\d{")}}$`).test(s)) throw bad(`${label}: ${n.join(" или ")} цифр`); return s; };
const bankOrNull = v => { if (v == null || v === "") return null; const b = db.prepare("SELECT id FROM bank_accounts WHERE id=? AND active=1").get(int(v)); if (!b) throw bad("Расчётный счёт не найден"); return b.id; };
route("POST", "/api/clients", "admin", ({ body }) => {
  const name = str(body.name, 160).replace(/\s+/g, " "), ckey = norm(name);
  if (!ckey) throw bad("Укажите название клиента");
  const card = { inn: digits(body.inn, [10, 12], "ИНН"), kpp: digits(body.kpp, [9], "КПП"), ogrn: digits(body.ogrn, [13, 15], "ОГРН"),
    address: str(body.address, 300), bank_id: bankOrNull(body.bank_id) };
  db.prepare(`INSERT INTO clients(ckey,name,inn,kpp,ogrn,address,bank_id,created) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(ckey) DO UPDATE SET inn=excluded.inn, kpp=excluded.kpp, ogrn=excluded.ogrn, address=excluded.address, bank_id=excluded.bank_id`)
    .run(ckey, name, card.inn, card.kpp, card.ogrn, card.address, card.bank_id, now());
  return { ok: true, ckey };
});
/* переименовать клиента или слить два написания в одно («ИП Чипчиков» → «ИП Чипчиков Р.»):
   остатки, товары, журнал, приёмки, услуги, счета, цены, подразделения и логины переезжают на новое имя */
route("POST", "/api/clients/rename", "admin", ({ body }) => {
  const from = norm(body.from), to = str(body.to, 160).replace(/\s+/g, " "), tk = norm(to);
  if (!from) throw bad("Не выбран клиент");
  if (!tk) throw bad("Укажите новое название");
  const users = db.prepare("SELECT id, client FROM users WHERE role='client'").all().filter(u => norm(u.client) === from).map(u => u.id);
  const moved = tx(() => {
    let n = 0;
    for (const r of db.prepare("SELECT * FROM stock WHERE ckey=?").all(from)) {
      if (from !== tk) { Q.stockDel.run(r.id); addStock(r.cell, to, r.article, r.name, r.qty); }
      n += r.qty;
    }
    db.prepare("UPDATE stock SET client=? WHERE ckey=?").run(to, tk);
    for (const p of db.prepare("SELECT * FROM products WHERE ckey=?").all(from)) {
      const t = from !== tk && Q.prodByKey.get(tk, p.akey);
      if (t) {
        const bcs = JSON.stringify([...new Set([...JSON.parse(t.barcodes), ...JSON.parse(p.barcodes)])]);
        db.prepare("DELETE FROM products WHERE id=?").run(p.id);
        Q.prodUpd.run(t.name || p.name, bcs, now(), t.id);
      } else db.prepare("UPDATE products SET client=?, ckey=? WHERE id=?").run(to, tk, p.id);
    }
    db.prepare("UPDATE products SET client=? WHERE ckey=?").run(to, tk);
    for (const t of ["ops", "receipts", "charges", "invoices"]) db.prepare(`UPDATE ${t} SET client=?, ckey=? WHERE ckey=?`).run(to, tk, from);
    if (from !== tk) {
      db.prepare("INSERT OR IGNORE INTO client_prices(ckey,service_id,price) SELECT ?, service_id, price FROM client_prices WHERE ckey=?").run(tk, from);
      db.prepare("DELETE FROM client_prices WHERE ckey=?").run(from);
      db.prepare("UPDATE client_subs SET ckey=? WHERE ckey=?").run(tk, from);
      const card = db.prepare("SELECT * FROM clients WHERE ckey=?").get(from);
      if (card && !db.prepare("SELECT 1 FROM clients WHERE ckey=?").get(tk)) db.prepare("UPDATE clients SET ckey=?, name=? WHERE ckey=?").run(tk, to, from);
      else db.prepare("DELETE FROM clients WHERE ckey=?").run(from);
    }
    db.prepare("UPDATE clients SET name=? WHERE ckey=?").run(to, tk);
    for (const id of users) db.prepare("UPDATE users SET client=? WHERE id=?").run(to, id);
    return n;
  });
  users.forEach(closeStreams);
  broadcast(["stock", "products", "ops", "receipts", "billing"], [tk]);
  return { ok: true, units: moved, logins: users.length };
});
route("POST", "/api/clients/sub", "admin", ({ body }) => {
  const name = str(body.name, 120);
  if (!name) throw bad("Укажите название подразделения");
  const bank = bankOrNull(body.bank_id);
  if (body.id) {
    const s = db.prepare("SELECT * FROM client_subs WHERE id=?").get(int(body.id));
    if (!s) throw bad("Подразделение не найдено");
    db.prepare("UPDATE client_subs SET name=?, bank_id=? WHERE id=?").run(name, bank, s.id);
    return { ok: true, id: s.id };
  }
  const ckey = norm(body.client);
  if (!ckey) throw bad("Выберите клиента");
  return { ok: true, id: Number(db.prepare("INSERT INTO client_subs(ckey,name,bank_id,created) VALUES(?,?,?,?)").run(ckey, name, bank, now()).lastInsertRowid) };
});
route("POST", "/api/clients/sub/delete", "admin", ({ body }) => {
  const s = db.prepare("SELECT * FROM client_subs WHERE id=?").get(int(body.id));
  if (!s) throw bad("Подразделение не найдено");
  tx(() => { db.prepare("UPDATE users SET sub_id=NULL WHERE sub_id=?").run(s.id); db.prepare("DELETE FROM client_subs WHERE id=?").run(s.id); });
  return { ok: true };
});
route("GET", "/api/banks", "admin", () => ({ banks: db.prepare(`SELECT ${BANK_COLS} FROM bank_accounts WHERE active=1 ORDER BY is_default DESC, id`).all() }));
route("POST", "/api/banks", "admin", ({ body }) => {
  const b = { title: str(body.title, 80), bank_name: str(body.bank_name, 160), bik: digits(body.bik, [9], "БИК"),
    account: digits(body.account, [20], "Расчётный счёт"), corr_account: digits(body.corr_account, [20], "Корр. счёт") };
  if (!b.bank_name || !b.account) throw bad("Укажите банк и расчётный счёт");
  if (body.id) {
    const cur = db.prepare("SELECT * FROM bank_accounts WHERE id=? AND active=1").get(int(body.id));
    if (!cur) throw bad("Расчётный счёт не найден");
    db.prepare("UPDATE bank_accounts SET title=?, bank_name=?, bik=?, account=?, corr_account=? WHERE id=?").run(b.title, b.bank_name, b.bik, b.account, b.corr_account, cur.id);
    return { ok: true, id: cur.id };
  }
  const first = db.prepare("SELECT COUNT(*) n FROM bank_accounts WHERE active=1").get().n === 0;
  const id = Number(db.prepare("INSERT INTO bank_accounts(title,bank_name,bik,account,corr_account,is_default,created) VALUES(?,?,?,?,?,?,?)")
    .run(b.title, b.bank_name, b.bik, b.account, b.corr_account, first ? 1 : 0, now()).lastInsertRowid);
  return { ok: true, id };
});
route("POST", "/api/banks/default", "admin", ({ body }) => {
  const b = db.prepare("SELECT id FROM bank_accounts WHERE id=? AND active=1").get(int(body.id));
  if (!b) throw bad("Расчётный счёт не найден");
  tx(() => { db.exec("UPDATE bank_accounts SET is_default=0"); db.prepare("UPDATE bank_accounts SET is_default=1 WHERE id=?").run(b.id); });
  return { ok: true };
});
route("POST", "/api/banks/delete", "admin", ({ body }) => {
  const b = db.prepare("SELECT * FROM bank_accounts WHERE id=? AND active=1").get(int(body.id));
  if (!b) throw bad("Расчётный счёт не найден");
  if (b.is_default) throw conflict("Это основной счёт. Сначала сделайте основным другой.");
  tx(() => {
    db.prepare("UPDATE bank_accounts SET active=0 WHERE id=?").run(b.id);
    db.prepare("UPDATE clients SET bank_id=NULL WHERE bank_id=?").run(b.id);
    db.prepare("UPDATE client_subs SET bank_id=NULL WHERE bank_id=?").run(b.id);
  });
  return { ok: true };
});
/* поиск организации по ИНН и банка по БИК — через DaData (ключ хранится на сервере и в браузер не уходит) */
async function dadata(kind, query) {
  const key = (db.prepare("SELECT value FROM settings WHERE key='dadata_key'").get() || {}).value;
  if (!key) throw bad("Поиск не настроен: добавьте ключ DaData в «Счета → Реквизиты» (бесплатно на dadata.ru)");
  let r;
  try {
    r = await fetch(`https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/${kind}`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Token " + key },
      body: JSON.stringify({ query, count: 1 }), signal: AbortSignal.timeout(8000),
    });
  } catch (e) { throw new HttpError(502, "Сервис поиска не ответил. Попробуйте ещё раз или заполните вручную."); }
  if (r.status === 401 || r.status === 403) throw bad("Ключ DaData не подошёл. Проверьте его в реквизитах.");
  if (!r.ok) throw new HttpError(502, "Сервис поиска вернул ошибку. Попробуйте позже.");
  const j = await r.json();
  return (j.suggestions || [])[0] || null;
}
route("GET", "/api/lookup/party", "admin", async ({ url }) => {
  const inn = digits(url.searchParams.get("inn"), [10, 12], "ИНН");
  if (!inn) throw bad("Введите ИНН");
  const s = await dadata("party", inn);
  if (!s) throw new HttpError(404, "Организация с таким ИНН не найдена");
  const d = s.data || {};
  return { name: s.value || "", full_name: (d.name && d.name.full_with_opf) || "", inn: d.inn || inn, kpp: d.kpp || "", ogrn: d.ogrn || "",
    address: (d.address && d.address.value) || "", director: (d.management && d.management.name) || "" };
});
route("GET", "/api/lookup/bank", "admin", async ({ url }) => {
  const bik = digits(url.searchParams.get("bik"), [9], "БИК");
  if (!bik) throw bad("Введите БИК");
  const s = await dadata("bank", bik);
  if (!s) throw new HttpError(404, "Банк с таким БИК не найден");
  const d = s.data || {};
  return { bank_name: s.value || "", bik: d.bic || bik, corr_account: d.correspondent_account || "" };
});

/* ---------- учёт услуг и счета ---------- */
/* Сутки считаются по московскому времени (сервер на хостинге живёт в UTC) */
const DAY_SHIFT = (process.env.TZ_OFFSET_HOURS != null ? +process.env.TZ_OFFSET_HOURS : 3) * 3600e3;
const dayOf = ts => new Date(Date.parse(ts) + DAY_SHIFT).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const money = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
function parseDay(v, field) {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + "T00:00:00Z")) || new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s)
    throw bad(`Неверная дата «${field}»`);
  return s;
}
function parsePrice(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw bad("Цена должна быть числом не меньше нуля");
  return money(n);
}

const B = {
  svcById: db.prepare("SELECT * FROM services WHERE id=?"),
  svcByKind: db.prepare("SELECT * FROM services WHERE kind=? AND active=1 ORDER BY id"),
  cpGet: db.prepare("SELECT price FROM client_prices WHERE ckey=? AND service_id=?"),
  chIns: db.prepare("INSERT INTO charges(client,ckey,service_id,qty,price,amount,day,period_from,period_to,note,invoice_id,user_id,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"),
  invById: db.prepare("SELECT * FROM invoices WHERE id=?"),
};
const priceFor = (ckey, svc) => { const r = B.cpGet.get(ckey, svc.id); return r ? r.price : svc.price; };
function addCharge(user, client, svc, qty, day, note, extra = {}) {
  client = str(client);
  const ckey = norm(client), price = priceFor(ckey, svc);
  return Number(B.chIns.run(client, ckey, svc.id, qty, price, money(qty * price), day, extra.from || null, extra.to || null,
    str(note, 300), extra.invoiceId || null, user ? user.id : null, now()).lastInsertRowid);
}
/* вызывается внутри tx приёмки и сборки */
function autoCharge(user, kind, client, qty, note) {
  if (!(qty > 0) || !str(client)) return;
  for (const svc of B.svcByKind.all(kind)) addCharge(user, client, svc, qty, dayOf(now()), note);
}
/* Хранение: остаток клиента на конец каждых суток периода, в штуко-сутках.
   Идём назад от текущего остатка, вычитая движения, — так результат верен, даже если ранняя история неполная. */
function storageUnitDays(ckey, from, to) {
  let bal = db.prepare("SELECT COALESCE(SUM(qty),0) n FROM stock WHERE ckey=?").get(ckey).n;
  const since = new Date(Date.parse(from + "T00:00:00Z") - DAY_SHIFT).toISOString();
  const delta = new Map();
  for (const o of db.prepare("SELECT ts, type, qty FROM ops WHERE ckey=? AND ts>=? AND type IN ('receive','pick','inventory','adjust')").all(ckey, since)) {
    const d = dayOf(o.ts), q = o.type === "pick" ? -Math.abs(o.qty) : o.type === "receive" ? Math.abs(o.qty) : o.qty;
    delta.set(d, (delta.get(d) || 0) + q);
  }
  for (const [d, q] of delta) if (d > to) bal -= q;
  let units = 0;
  for (let d = to; d >= from; d = addDays(d, -1)) { units += Math.max(bal, 0); bal -= delta.get(d) || 0; }
  return units;
}
function storageBilledUntil(ckey) {
  return db.prepare(`SELECT MAX(c.period_to) d FROM charges c JOIN services s ON s.id=c.service_id JOIN invoices i ON i.id=c.invoice_id
    WHERE c.ckey=? AND s.kind='storage' AND i.status<>'cancelled'`).get(ckey).d || "";
}
const CHARGE_SELECT = `SELECT c.id, c.client, c.service_id, c.qty, c.price, c.amount, c.day, c.period_from, c.period_to, c.note, c.invoice_id,
  s.name AS service, s.unit, s.kind, i.number AS invoice_number, u.name AS user_name
  FROM charges c JOIN services s ON s.id=c.service_id LEFT JOIN invoices i ON i.id=c.invoice_id LEFT JOIN users u ON u.id=c.user_id`;
/* что войдёт в счёт: невыставленные услуги за период + хранение за ещё не оплаченные сутки */
function invoiceDraft(client, from, to) {
  const ckey = norm(client);
  const charges = db.prepare(`${CHARGE_SELECT} WHERE c.ckey=? AND c.invoice_id IS NULL AND c.day BETWEEN ? AND ? ORDER BY c.day, c.id`).all(ckey, from, to);
  let storage = null;
  const svc = B.svcByKind.get("storage");
  if (svc) {
    const billed = storageBilledUntil(ckey);
    const sFrom = billed && billed >= from ? addDays(billed, 1) : from;
    if (sFrom <= to) {
      const units = storageUnitDays(ckey, sFrom, to);
      if (units > 0) {
        const price = priceFor(ckey, svc);
        storage = { svc, qty: units, price, amount: money(units * price), from: sFrom, to };
      }
    }
  }
  return { charges, storage };
}
function groupLines(charges) {
  const m = new Map();
  for (const c of charges) {
    const k = c.service_id + "|" + c.price;
    const l = m.get(k) || { service: c.service, unit: c.unit, price: c.price, qty: 0, amount: 0 };
    l.qty = money(l.qty + c.qty); l.amount = money(l.amount + c.amount); m.set(k, l);
  }
  return [...m.values()];
}
const storageLine = s => ({ service_id: s.svc.id, service: s.svc.name, unit: s.svc.unit, price: s.price, qty: s.qty, amount: s.amount });
const getSettings = () => Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map(r => [r.key, r.value]));
/* реквизиты для документов: без секретов и без картинок печати/подписи */
const docSettings = () => { const s = getSettings(); for (const k of [...SECRET_KEYS, ...IMAGE_KEYS]) delete s[k]; return s; };
/* расчётный счёт для документа: подразделение → клиент → основной */
function bankFor(ckey, subId) {
  const sub = subId ? db.prepare("SELECT bank_id FROM client_subs WHERE id=?").get(subId) : null;
  const card = db.prepare("SELECT bank_id FROM clients WHERE ckey=?").get(ckey);
  const id = (sub && sub.bank_id) || (card && card.bank_id);
  return (id && db.prepare("SELECT * FROM bank_accounts WHERE id=? AND active=1").get(id)) || db.prepare("SELECT * FROM bank_accounts WHERE active=1 ORDER BY is_default DESC, id LIMIT 1").get() || null;
}
/* снимок реквизитов на момент выставления: позже поменяете банк или адрес — старые счета останутся как были */
function docSnapshot(client, ckey, subId) {
  const s = docSettings(), bank = bankFor(ckey, subId);
  const card = db.prepare("SELECT * FROM clients WHERE ckey=?").get(ckey) || {};
  const sub = subId ? db.prepare("SELECT name FROM client_subs WHERE id=?").get(subId) : null;
  return {
    supplier: { name: s.company_name || "", inn: s.company_inn || "", kpp: s.company_kpp || "", ogrn: s.company_ogrn || "", address: s.company_address || "",
      director: s.director || "", accountant: s.accountant || "", vat_note: s.vat_note || "" },
    bank: bank ? { bank_name: bank.bank_name, bik: bank.bik, account: bank.account, corr_account: bank.corr_account }
      : { bank_name: s.bank_name || "", bik: s.bank_bik || "", account: s.bank_account || "", corr_account: s.bank_corr_account || "" },
    payer: { name: card.name || client, inn: card.inn || "", kpp: card.kpp || "", address: card.address || "", sub: sub ? sub.name : "" },
  };
}
/* клиент видит только свою компанию, сотрудник — любую (?client=...) */
function billingClient(user, url, required) {
  if (user.role === "client") {
    if (!norm(user.client)) throw bad("Аккаунт не привязан к клиенту. Обратитесь на склад.");
    return user.client;
  }
  if (!can(user, "services")) throw new HttpError(403, "Нет доступа");
  const c = str(url.searchParams.get("client"));
  if (required && !c) throw bad("Выберите клиента");
  return c;
}

route("GET", "/api/billing/services", "perm:services", () => ({ services: db.prepare("SELECT * FROM services ORDER BY active DESC, id").all() }));
route("POST", "/api/billing/services", "admin", ({ body }) => {
  const name = str(body.name, 120), unit = str(body.unit, 20) || "шт";
  if (!name) throw bad("Укажите название услуги");
  const price = parsePrice(body.price);
  db.prepare("INSERT INTO services(code,name,unit,price,kind) VALUES(?,?,?,?,'manual')").run("S" + crypto.randomBytes(4).toString("hex").toUpperCase(), name, unit, price);
  broadcast(["billing"]);
  return { ok: true };
});
route("POST", "/api/billing/services/update", "admin", ({ body }) => {
  const s = B.svcById.get(int(body.id));
  if (!s) throw bad("Услуга не найдена");
  const name = body.name != null ? str(body.name, 120) || s.name : s.name;
  const unit = body.unit != null ? str(body.unit, 20) || s.unit : s.unit;
  const price = body.price != null ? parsePrice(body.price) : s.price;
  const active = body.active != null ? (body.active ? 1 : 0) : s.active;
  db.prepare("UPDATE services SET name=?, unit=?, price=?, active=? WHERE id=?").run(name, unit, price, active, s.id);
  broadcast(["billing"]);
  return { ok: true };
});

route("GET", "/api/billing/prices", "perm:services", ({ url }) => {
  const ck = norm(url.searchParams.get("client"));
  if (!ck) throw bad("Выберите клиента");
  return {
    prices: db.prepare(`SELECT s.id AS service_id, s.name, s.unit, s.price AS default_price, cp.price AS client_price
      FROM services s LEFT JOIN client_prices cp ON cp.service_id=s.id AND cp.ckey=? WHERE s.active=1 ORDER BY s.id`).all(ck),
  };
});
route("POST", "/api/billing/prices", "admin", ({ body }) => {
  const ck = norm(body.client), s = B.svcById.get(int(body.service_id));
  if (!ck) throw bad("Выберите клиента");
  if (!s) throw bad("Услуга не найдена");
  if (body.price == null || String(body.price).trim() === "") db.prepare("DELETE FROM client_prices WHERE ckey=? AND service_id=?").run(ck, s.id);
  else db.prepare("INSERT INTO client_prices(ckey,service_id,price) VALUES(?,?,?) ON CONFLICT(ckey,service_id) DO UPDATE SET price=excluded.price").run(ck, s.id, parsePrice(body.price));
  return { ok: true };
});

route("GET", "/api/billing/charges", "any", ({ user, url }) => {
  const client = billingClient(user, url, false);
  const where = [], args = [];
  if (client) { where.push("c.ckey=?"); args.push(norm(client)); }
  if (url.searchParams.get("open") === "1") where.push("c.invoice_id IS NULL");
  const rows = db.prepare(`${CHARGE_SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY c.day DESC, c.id DESC LIMIT 1000`).all(...args);
  if (user.role === "client") rows.forEach(r => { delete r.user_name; });
  return { charges: rows };
});
route("POST", "/api/billing/charges", "perm:services", ({ body, user }) => {
  const client = str(body.client, 120), s = B.svcById.get(int(body.service_id));
  const qty = money(Number(String(body.qty ?? "").replace(",", ".")));
  if (!client) throw bad("Укажите клиента");
  if (!s || !s.active) throw bad("Выберите услугу");
  if (s.kind === "storage") throw bad("Хранение считается само при выставлении счёта");
  if (!(qty > 0)) throw bad("Количество должно быть больше нуля");
  const day = body.day ? parseDay(body.day, "Дата") : dayOf(now());
  const id = tx(() => addCharge(user, client, s, qty, day, body.note));
  broadcast(["billing"], [norm(client)]);
  return { ok: true, id };
});
route("POST", "/api/billing/charges/delete", "admin", ({ body }) => {
  const c = db.prepare("SELECT * FROM charges WHERE id=?").get(int(body.id));
  if (!c) throw bad("Начисление не найдено");
  if (c.invoice_id) throw conflict("Услуга уже в счёте. Сначала отмените счёт.");
  db.prepare("DELETE FROM charges WHERE id=?").run(c.id);
  broadcast(["billing"], [c.ckey]);
  return { ok: true };
});

route("GET", "/api/billing/preview", "admin", ({ url }) => {
  const client = str(url.searchParams.get("client"));
  if (!client) throw bad("Выберите клиента");
  const from = parseDay(url.searchParams.get("from"), "с"), to = parseDay(url.searchParams.get("to"), "по");
  if (from > to) throw bad("Дата начала позже даты окончания");
  const { charges, storage } = invoiceDraft(client, from, to);
  const lines = groupLines(charges.concat(storage ? [storageLine(storage)] : []));
  return { lines, total: money(lines.reduce((a, l) => a + l.amount, 0)), storage: storage ? { from: storage.from, to: storage.to, qty: storage.qty } : null };
});
route("GET", "/api/billing/invoices", "any", ({ user, url }) => {
  const client = billingClient(user, url, false);
  const where = [], args = [];
  if (client) { where.push("i.ckey=?"); args.push(norm(client)); }
  if (user.role === "client") where.push("i.status<>'cancelled'");
  // логин подразделения видит счета своего подразделения и общие счета клиента
  if (user.role === "client" && user.sub_id) { where.push("(i.sub_id IS NULL OR i.sub_id=?)"); args.push(user.sub_id); }
  return { invoices: db.prepare(`SELECT i.id, i.number, i.client, i.period_from, i.period_to, i.total, i.status, i.created, i.paid, i.sub_id, s.name AS sub_name
    FROM invoices i LEFT JOIN client_subs s ON s.id=i.sub_id${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY i.id DESC LIMIT 500`).all(...args) };
});
route("POST", "/api/billing/invoices", "admin", ({ body, user }) => {
  const client = str(body.client, 120);
  if (!client) throw bad("Выберите клиента");
  const subId = body.sub_id ? checkSub(client, body.sub_id) : null;
  const from = parseDay(body.from, "с"), to = parseDay(body.to, "по");
  if (from > to) throw bad("Дата начала позже даты окончания");
  const out = tx(() => {
    const { charges, storage } = invoiceDraft(client, from, to);
    if (!charges.length && !storage) throw bad("За этот период нет невыставленных услуг");
    const year = to.slice(0, 4);
    const seq = db.prepare("SELECT COUNT(*) n FROM invoices WHERE number LIKE ?").get(year + "-%").n + 1;
    const number = `${year}-${String(seq).padStart(4, "0")}`;
    const snap = docSnapshot(client, norm(client), subId);
    const bank = bankFor(norm(client), subId);
    const id = Number(db.prepare("INSERT INTO invoices(number,client,ckey,period_from,period_to,user_id,created,sub_id,bank_id,doc) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(number, charges[0] ? charges[0].client : client, norm(client), from, to, user.id, now(), subId, bank ? bank.id : null, JSON.stringify(snap)).lastInsertRowid);
    const link = db.prepare("UPDATE charges SET invoice_id=? WHERE id=?");
    for (const c of charges) link.run(id, c.id);
    if (storage) addCharge(user, client, storage.svc, storage.qty, storage.to, `Хранение с ${storage.from} по ${storage.to}`, { from: storage.from, to: storage.to, invoiceId: id });
    const total = money(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM charges WHERE invoice_id=?").get(id).n);
    db.prepare("UPDATE invoices SET total=? WHERE id=?").run(total, id);
    return { id, number, total };
  });
  broadcast(["billing"], [norm(client)]);
  return { ok: true, ...out };
});
route("GET", "/api/billing/invoice", "any", ({ user, url }) => {
  const inv = B.invById.get(int(url.searchParams.get("id")));
  if (!inv || (user.role === "client" && (inv.ckey !== norm(user.client) || inv.status === "cancelled" || (user.sub_id && inv.sub_id && inv.sub_id !== user.sub_id)))) throw new HttpError(404, "Счёт не найден");
  if (user.role !== "client" && !can(user, "services")) throw new HttpError(403, "Нет доступа");
  const charges = db.prepare(`${CHARGE_SELECT} WHERE c.invoice_id=? ORDER BY c.day, c.id`).all(inv.id);
  const { ckey, user_id, doc, ...pub } = inv;
  const snap = doc ? JSON.parse(doc) : docSnapshot(inv.client, inv.ckey, inv.sub_id);
  const s = getSettings();
  // печать и подпись ставятся на документы, которые склад выдаёт клиенту
  return { invoice: { ...pub, lines: groupLines(charges) }, doc: snap, stamp: s.stamp_png || "", sign: s.sign_png || "" };
});
route("POST", "/api/billing/invoices/status", "admin", ({ body }) => {
  const inv = B.invById.get(int(body.id));
  if (!inv) throw bad("Счёт не найден");
  if (inv.status === "cancelled") throw conflict("Счёт уже отменён");
  if (body.action === "paid") db.prepare("UPDATE invoices SET status='paid', paid=? WHERE id=?").run(now(), inv.id);
  else if (body.action === "issued") db.prepare("UPDATE invoices SET status='issued', paid=NULL WHERE id=?").run(inv.id);
  else if (body.action === "cancel") tx(() => {
    // посчитанное для счёта хранение удаляем, остальные услуги снова становятся невыставленными
    db.prepare("DELETE FROM charges WHERE invoice_id=? AND service_id IN (SELECT id FROM services WHERE kind='storage')").run(inv.id);
    db.prepare("UPDATE charges SET invoice_id=NULL WHERE invoice_id=?").run(inv.id);
    db.prepare("UPDATE invoices SET status='cancelled' WHERE id=?").run(inv.id);
  });
  else throw bad("Неизвестное действие");
  broadcast(["billing"], [inv.ckey]);
  return { ok: true };
});
route("GET", "/api/billing/summary", "admin", () => {
  const month = dayOf(now()).slice(0, 8) + "01";
  const c = db.prepare("SELECT COALESCE(SUM(CASE WHEN invoice_id IS NULL THEN amount END),0) open, COALESCE(SUM(CASE WHEN day>=? THEN amount END),0) month FROM charges").get(month);
  const unpaid = db.prepare("SELECT COALESCE(SUM(total),0) n FROM invoices WHERE status='issued'").get().n;
  return { open: money(c.open), month: money(c.month), unpaid: money(unpaid) };
});
route("GET", "/api/billing/settings", "admin", () => ({ settings: getSettings() }));
route("POST", "/api/billing/settings", "admin", ({ body }) => {
  const up = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  tx(() => {
    for (const k of SETTINGS_KEYS) {
      if (body[k] == null) continue;
      if (IMAGE_KEYS.includes(k)) {
        const v = String(body[k]);
        if (v && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v)) throw bad("Печать и подпись загружаются картинкой PNG");
        if (v.length > 1.5e6) throw bad("Картинка слишком большая: уменьшите её до 1 МБ");
        up.run(k, v);
      } else up.run(k, str(body[k], 300));
    }
  });
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
    if (r.access && r.access.startsWith("perm:") && !r.access.slice(5).split("|").some(p => can(user, p)))
      return send(res, 403, { error: "Нет прав на этот раздел. Их назначает администратор." });
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

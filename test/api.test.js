"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sklad-test-"));
const { server } = require("../server.js");
let base;

function agent() {
  let cookie = "";
  return async (method, url, body) => {
    const r = await fetch(base + url, {
      method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const j = await r.json().catch(() => null);
    return { status: r.status, ...j };
  };
}

before(() => new Promise(ok => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; ok(); })));
after(() => new Promise(ok => server.close(ok)));

const admin = agent(), worker = agent(), anon = agent();

test("первый запуск: создаём администратора", async () => {
  assert.equal((await anon("GET", "/api/me")).needSetup, true);
  assert.equal((await anon("GET", "/api/data")).status, 401);
  assert.equal((await admin("POST", "/api/setup", { login: "Boss", name: "Хозяин", password: "secret1" })).ok, true);
  assert.equal((await anon("POST", "/api/setup", { login: "evil", password: "secret1" })).status, 409);
  const me = await admin("GET", "/api/me");
  assert.equal(me.user.role, "admin");
  assert.equal(me.user.login, "boss");
});

test("сотрудник: создание, вход, ограничения прав", async () => {
  assert.equal((await admin("POST", "/api/users", { login: "ivan", name: "Иван", password: "123456", role: "worker" })).ok, true);
  assert.equal((await worker("POST", "/api/login", { login: "ivan", password: "wrong" })).status, 401);
  assert.equal((await worker("POST", "/api/login", { login: "IVAN", password: "123456" })).ok, true);
  assert.equal((await worker("GET", "/api/users")).status, 403);
  assert.equal((await worker("POST", "/api/adjust", { mode: "delta", cell: "A-01", client: "К", article: "X", delta: 5 })).status, 403);
});

test("приёмка → размещение → сборка → инвентаризация", async () => {
  const r = await worker("POST", "/api/receive", {
    client: "ООО Ромашка", doc: "П-1", cell: "", lines: [
      { article: "art-1", name: "Кружка", barcode: "4600000000017", expected: 10, got: 10 },
      { article: "ART-2", name: "Плед", got: 3 },
    ],
  });
  assert.equal(r.ok, true);
  let d = await worker("GET", "/api/data");
  assert.equal(d.stock.length, 2);
  assert.ok(d.stock.every(s => s.cell === "PRIEM"));
  assert.deepEqual(d.products.find(p => p.article === "art-1").barcodes, ["4600000000017"]);

  const a1 = d.stock.find(s => s.article === "art-1");
  // кириллическая «А» в адресе превращается в латинскую
  const mv = await worker("POST", "/api/move", { from: "PRIEM", to: "А-01-1-01", items: [{ id: a1.id, qty: 7 }] });
  assert.equal(mv.units, 7);
  const tooMuch = await worker("POST", "/api/move", { from: "PRIEM", to: "A-01-1-02", items: [{ id: a1.id, qty: 99 }] });
  assert.equal(tooMuch.status, 409);

  d = await worker("GET", "/api/data");
  const placed = d.stock.find(s => s.cell === "A-01-1-01");
  assert.equal(placed.qty, 7);
  assert.ok(d.cells.includes("A-01-1-01"));

  const pk = await worker("POST", "/api/pick", { doc: "WB", items: [{ id: placed.id, qty: 2 }] });
  assert.equal(pk.units, 2);
  const inv = await worker("POST", "/api/inventory", { cell: "A-01-1-01", lines: [{ client: "ООО Ромашка", article: "ART-1", name: "Кружка", counted: 4 }] });
  assert.equal(inv.changed, 1);

  d = await worker("GET", "/api/data");
  assert.equal(d.stock.find(s => s.cell === "A-01-1-01").qty, 4);
  const types = d.ops.map(o => o.type);
  for (const t of ["receive", "putaway", "pick", "inventory"]) assert.ok(types.includes(t), t);
  assert.equal(d.ops[0].user_name, "Иван");
});

test("штрихкод нельзя привязать к двум товарам", async () => {
  const r = await admin("POST", "/api/products", { client: "ООО Ромашка", article: "ART-9", name: "Другое", barcodes: ["4600000000017"] });
  assert.equal(r.status, 409);
});

test("администратор: корректировка, загрузка раскладки, удаление ячеек, резервная копия", async () => {
  assert.equal((await admin("POST", "/api/adjust", { mode: "delta", cell: "B-02", client: "ИП Иванов", article: "Z", name: "Зонт", delta: 5 })).ok, true);
  const imp = await admin("POST", "/api/import-stock", { file: "t.xlsx", rows: [{ cell: "C-01", client: "ИП Иванов", article: "Q", qty: 3 }, { cell: "", article: "bad", qty: 1 }] });
  assert.equal(imp.ok, 1);
  await admin("POST", "/api/cells", { cells: ["D-01", "D-02"] });
  assert.equal((await admin("POST", "/api/cells/delete", { cells: ["D-01", "C-01"] })).ok, 1);
  const b = await fetch(base + "/api/backup", { headers: { Cookie: "" } });
  assert.equal(b.status, 401);
});

test("нельзя отключить последнего администратора", async () => {
  const { users } = await admin("GET", "/api/users");
  const boss = users.find(u => u.login === "boss");
  assert.equal((await admin("POST", "/api/users/update", { id: boss.id, role: "worker" })).status, 409);
});

test("кабинет клиента: видит только свои данные и ничего не может менять", async () => {
  // у склада два клиента: «ООО Ромашка» (из приёмки выше) и «ИП Иванов»
  assert.equal((await admin("POST", "/api/users", { login: "romashka", name: "Ольга", password: "client1", role: "client" })).status, 400, "клиент без компании");
  assert.equal((await admin("POST", "/api/users", { login: "romashka", name: "Ольга", password: "client1", role: "client", client: "ооо  ромашка", can_change_pw: true })).ok, true);
  const cl = agent();
  assert.equal((await cl("POST", "/api/login", { login: "romashka", password: "client1" })).ok, true);
  const me = await cl("GET", "/api/me");
  assert.equal(me.user.role, "client");

  const my = await cl("GET", "/api/my");
  assert.equal(my.client, "ООО Ромашка");
  assert.ok(my.stock.length > 0);
  assert.ok(my.stock.every(s => !("client" in s)), "в ответе нет поля client");
  const arts = new Set([...my.stock, ...my.products, ...my.ops].map(x => x.article.toLowerCase()));
  for (const foreign of ["z", "q", "live-1"]) assert.ok(!arts.has(foreign), "чужой артикул " + foreign);
  assert.ok(my.ops.every(o => ["receive", "pick", "inventory", "adjust"].includes(o.type)));
  assert.ok(my.ops.every(o => !("user_id" in o) && !("user_name" in o)), "клиент не видит сотрудников");
  assert.equal(my.receipts.length, 1);

  // параметр ?client= клиент подменить не может
  const spoof = await cl("GET", "/api/my?client=" + encodeURIComponent("ИП Иванов"));
  assert.equal(spoof.client, "ООО Ромашка");
  assert.ok(!spoof.stock.some(s => s.article === "Z"));

  // складские и админские эндпоинты закрыты
  for (const [m, u, b] of [
    ["GET", "/api/data"], ["POST", "/api/receive", { client: "x", lines: [{ article: "a", got: 1 }] }],
    ["POST", "/api/move", { from: "PRIEM", to: "A", items: [{ id: 1, qty: 1 }] }], ["POST", "/api/pick", { items: [{ id: 1, qty: 1 }] }],
    ["POST", "/api/inventory", { cell: "A-01-1-01", lines: [] }], ["POST", "/api/products", { client: "x", article: "y" }],
    ["POST", "/api/products/bulk", { rows: [] }], ["POST", "/api/products/from-stock", {}], ["POST", "/api/cells", { cells: ["X-1"] }],
  ]) assert.equal((await cl(m, u, b)).status, 403, u);
  for (const [m, u] of [["GET", "/api/users"], ["POST", "/api/adjust"], ["POST", "/api/import-stock"], ["POST", "/api/cells/delete"], ["GET", "/api/backup"], ["POST", "/api/users"], ["POST", "/api/users/update"]]) {
    assert.equal((await cl(m, u, m === "POST" ? {} : undefined)).status, 403, u);
  }

  // сотрудник может открыть кабинет любого клиента для проверки
  const pv = await worker("GET", "/api/my?client=" + encodeURIComponent("ИП Иванов"));
  assert.ok(pv.stock.some(s => s.article === "Z"));
  assert.equal((await worker("GET", "/api/my")).status, 400);

  // смена своего пароля
  assert.equal((await cl("POST", "/api/password", { old: "wrong", password: "newpass1" })).status, 400);
  assert.equal((await cl("POST", "/api/password", { old: "client1", password: "newpass1" })).ok, true);
  assert.equal((await anon("POST", "/api/login", { login: "romashka", password: "newpass1" })).ok, true);

  // отключённый клиент теряет доступ сразу
  const { users } = await admin("GET", "/api/users");
  const r = users.find(u => u.login === "romashka");
  assert.equal(r.client, "ооо  ромашка");
  await admin("POST", "/api/users/update", { id: r.id, active: false });
  assert.equal((await cl("GET", "/api/my")).status, 401);
});

test("подбор пароля: подмена X-Forwarded-For не сбрасывает лимит по логину", async () => {
  await admin("POST", "/api/users", { login: "victim", name: "Жертва", password: "rightpw1", role: "worker" });
  for (let i = 0; i < 10; i++) {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.0.${i}` }, body: JSON.stringify({ login: "victim", password: "nope" + i }) });
    assert.equal(r.status, 401);
  }
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.9.9.9" }, body: JSON.stringify({ login: "victim", password: "rightpw1" }) });
  assert.equal(r.status, 429);
});

test("битые адреса и cookie дают 400/401, а не 500", async () => {
  assert.equal((await fetch(base + "/%E0%A4%A")).status, 400);
  assert.equal((await fetch(base + "/api/me", { headers: { Cookie: "sid=%" } })).status, 200);
});

test("кабинет: раскладка видна в движении, время обновления не уходит назад, поставки листаются", async () => {
  const name = "ИП Листалкин";
  await admin("POST", "/api/import-stock", { file: "old.xlsx", rows: [{ cell: "E-01", client: name, article: "L-1", qty: 2 }] });
  for (let i = 0; i < 103; i++) await admin("POST", "/api/receive", { client: name, doc: "R" + i, lines: [{ article: "L-2", got: 1 }] });
  const pv = await admin("GET", "/api/my?client=" + encodeURIComponent(name));
  assert.ok(pv.ops.some(o => o.article === "L-1" && o.type === "adjust" && o.qty === 2 && /old\.xlsx/.test(o.doc)), "строка раскладки в движении");
  assert.equal(pv.receipts.length, 100);
  assert.equal(pv.rcMore, true);
  const page2 = await admin("GET", `/api/my?client=${encodeURIComponent(name)}&rc_before=${pv.receipts[99].id}`);
  assert.equal(page2.receipts.length, 3);
  assert.equal(page2.rcMore, false);
  // полное списание: время обновления — момент последней операции
  const row = (await admin("GET", "/api/data?parts=stock")).stock.find(s => s.article === "L-1");
  await admin("POST", "/api/pick", { doc: "WB", items: [{ id: row.id, qty: 2 }] });
  const after = await admin("GET", "/api/my?client=" + encodeURIComponent(name));
  assert.equal(after.updated, after.ops[0].ts);
});

test("живые обновления: клиент получает сигнал только о своих товарах", async () => {
  await admin("POST", "/api/users", { login: "lilia", name: "Лилия", password: "client2", role: "client", client: "ООО Лилия" });
  const cl = agent();
  await cl("POST", "/api/login", { login: "lilia", password: "client2" });
  const sid = (await (async () => { const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: "lilia", password: "client2" }) }); return r.headers.get("set-cookie").split(";")[0]; })());
  const ctrl = new AbortController();
  const res = await fetch(base + "/api/events", { headers: { Cookie: sid }, signal: ctrl.signal });
  const reader = res.body.getReader();
  let text = "";
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } } catch (e) { } })();
  await new Promise(r => setTimeout(r, 150));
  await admin("POST", "/api/receive", { client: "ООО Ромашка", lines: [{ article: "X-OTHER", got: 1 }] });
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!text.includes("event: change"), "чужая приёмка не должна сигналить: " + text);
  await admin("POST", "/api/receive", { client: "ооо лилия", lines: [{ article: "MINE", got: 1 }] });
  await new Promise(r => setTimeout(r, 200));
  assert.match(text, /event: change\ndata: \{"parts":\["my"\]\}/);
  assert.ok(!text.includes("stock"), "клиенту не раскрываются разделы склада");
  ctrl.abort(); await pump;
});

test("статика и SPA", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
});

test("приёмка по списку с ячейками: товар сразу ложится в ячейки", async () => {
  const r = await admin("POST", "/api/receive", {
    client: "ИП Ячейкин", doc: "раскладка", cell: "", lines: [
      { article: "Y-1", name: "Берет", expected: 5, got: 5, cell: "В-01-1-02" },
      { article: "Y-1", name: "Берет", expected: 3, got: 3, cell: "D-02-1-03" },
      { article: "Y-2", name: "Кепка", got: 2 },
    ],
  });
  assert.equal(r.ok, true);
  const d = await admin("GET", "/api/data");
  const mine = d.stock.filter(s => s.client === "ИП Ячейкин").map(s => `${s.cell}:${s.article}:${s.qty}`).sort();
  assert.deepEqual(mine, ["B-01-1-02:Y-1:5", "D-02-1-03:Y-1:3", "PRIEM:Y-2:2"]);
  assert.ok(d.cells.includes("B-01-1-02") && d.cells.includes("D-02-1-03"));
});

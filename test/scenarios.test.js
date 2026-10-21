"use strict";
/* Сценарии глазами трёх ролей — администратора, кладовщика и клиента — с упором на ошибки ввода,
   права доступа и целостность остатков. Каждая проверка — то, что реально делают на складе. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sklad-scn-"));
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

const admin = agent(), worker = agent(), viewer = agent(), client = agent(), anon = agent();
const stockOf = async (who, cell, article) => (await who("GET", "/api/data?parts=stock")).stock.filter(s => (!cell || s.cell === cell) && (!article || s.article === article));
const units = rows => rows.reduce((a, r) => a + r.qty, 0);

test("вход и учётные записи", async () => {
  assert.equal((await admin("POST", "/api/setup", { login: "boss", name: "Хозяин", password: "short" })).status, 400, "короткий пароль при первом запуске");
  assert.equal((await admin("POST", "/api/setup", { login: "boss", name: "Хозяин", password: "secret1" })).ok, true);
  assert.equal((await anon("POST", "/api/login", { login: "boss", password: "" })).status, 401, "пустой пароль");
  assert.equal((await anon("POST", "/api/login", { login: "  BOSS ", password: "secret1" })).ok, true, "логин без учёта регистра и пробелов");
  assert.equal((await admin("POST", "/api/users", { login: "ив", name: "Иван", password: "123456" })).status, 400, "кириллический короткий логин");
  assert.equal((await admin("POST", "/api/users", { login: "ivan", name: "", password: "123456" })).status, 400, "без имени");
  assert.equal((await admin("POST", "/api/users", { login: "ivan", name: "Иван", password: "123" })).status, 400, "короткий пароль");
  assert.equal((await admin("POST", "/api/users", { login: "ivan", name: "Иван", password: "123456", role: "worker", perms: "ops" })).ok, true);
  assert.equal((await admin("POST", "/api/users", { login: "IVAN", name: "Иван 2", password: "123456" })).status, 409, "логин занят");
  assert.equal((await admin("POST", "/api/users", { login: "olga", name: "Ольга", password: "123456", role: "worker", perms: "stock" })).ok, true);
  assert.equal((await worker("POST", "/api/login", { login: "ivan", password: "123456" })).ok, true);
  assert.equal((await viewer("POST", "/api/login", { login: "olga", password: "123456" })).ok, true);
  const me = await worker("GET", "/api/me");
  assert.equal(me.user.role, "worker");
  assert.deepEqual(me.user.perms, ["ops"]);
});

test("кладовщик: приёмка — ошибки ввода", async () => {
  assert.equal((await worker("POST", "/api/receive", { client: "", lines: [{ article: "A", got: 1 }] })).status, 400, "без клиента");
  assert.equal((await worker("POST", "/api/receive", { client: "ООО Ромашка", lines: [] })).status, 400, "пустая приёмка");
  assert.equal((await worker("POST", "/api/receive", { client: "ООО Ромашка", lines: [{ article: "A", got: 0 }] })).status, 400, "всё по нулям");
  assert.equal((await worker("POST", "/api/receive", { client: "ООО Ромашка", lines: [{ article: "A", got: -5 }, { article: "B", got: 2 }] })).status, 400, "минус в приёмке");
  assert.equal((await worker("POST", "/api/receive", { client: "ООО Ромашка", lines: [{ article: "", got: 3 }] })).status, 400, "строка без артикула");
  assert.equal((await stockOf(worker)).length, 0, "после ошибок на складе пусто");
});

test("кладовщик: приёмка, одинаковые артикулы и написания клиента", async () => {
  const r1 = await worker("POST", "/api/receive", { client: "ООО Ромашка", doc: "WB-1", lines: [
    { article: "RM-1", name: "Футболка", barcode: "4600000000017", got: 10 },
    { article: "rm-1", name: "", got: 5 },
    { article: "RM-2", name: "Кружка", barcode: "4600000000024", got: 4 },
  ] });
  assert.equal(r1.ok, true);
  let s = await stockOf(worker, "PRIEM");
  assert.equal(s.length, 2, "rm-1 и RM-1 — один товар");
  assert.equal(units(s.filter(x => x.article.toLowerCase() === "rm-1")), 15);
  assert.equal(s.find(x => x.article.toLowerCase() === "rm-1").name, "Футболка", "пустое название не затирает");
  // второе написание клиента с лишними пробелами — тот же клиент
  assert.equal((await worker("POST", "/api/receive", { client: "  ооо   ромашка ", lines: [{ article: "RM-2", got: 1 }] })).ok, true);
  s = await stockOf(worker, "PRIEM", "RM-2");
  assert.equal(s.length, 1);
  assert.equal(s[0].qty, 5);
  assert.equal(s[0].client, "ООО Ромашка", "имя клиента не меняется от неаккуратного ввода");
  // приёмка сразу в ячейку, адрес с кириллицей и пробелами
  assert.equal((await worker("POST", "/api/receive", { client: "ИП Петров", cell: " а-01-1-01 ", lines: [{ article: "PT-1", name: "Чехол", got: 40 }] })).ok, true);
  assert.equal((await stockOf(worker, "A-01-1-01", "PT-1"))[0].qty, 40);
  const d = await worker("GET", "/api/data?parts=cells,receipts,products");
  assert.ok(d.cells.includes("A-01-1-01"), "ячейка из приёмки появилась в списке");
  assert.ok(!d.cells.includes("PRIEM"), "зона приёмки не считается ячейкой");
  assert.equal(d.receipts.length, 3);
  assert.equal(d.receipts[0].user_name, "Иван");
  assert.deepEqual(d.products.find(p => p.article === "RM-1").barcodes, ["4600000000017"]);
});

test("кладовщик: штрихкод чужого товара при приёмке не перепривязывается", async () => {
  const r = await worker("POST", "/api/receive", { client: "ИП Петров", lines: [{ article: "PT-2", name: "Другое", barcode: "4600000000017", got: 1 }] });
  assert.equal(r.ok, true);
  const p = (await worker("GET", "/api/data?parts=products")).products;
  assert.deepEqual(p.find(x => x.article === "RM-1").barcodes, ["4600000000017"], "штрихкод остался у первого товара");
  assert.deepEqual(p.find(x => x.article === "PT-2").barcodes, []);
});

test("кладовщик: размещение и перемещение", async () => {
  const rm1 = (await stockOf(worker, "PRIEM", "RM-1"))[0];
  assert.equal((await worker("POST", "/api/move", { from: "PRIEM", to: "", items: [{ id: rm1.id, qty: 1 }] })).status, 400, "без ячейки назначения");
  assert.equal((await worker("POST", "/api/move", { from: "PRIEM", to: "PRIEM", items: [{ id: rm1.id, qty: 1 }] })).status, 400, "в ту же ячейку");
  assert.equal((await worker("POST", "/api/move", { from: "PRIEM", to: "B-01", items: [] })).status, 400, "ничего не выбрано");
  assert.equal((await worker("POST", "/api/move", { from: "PRIEM", to: "B-01", items: [{ id: rm1.id, qty: 0 }] })).status, 400, "ноль штук");
  assert.equal((await worker("POST", "/api/move", { from: "PRIEM", to: "B-01", items: [{ id: rm1.id, qty: 16 }] })).status, 409, "больше, чем есть");
  assert.equal((await worker("POST", "/api/move", { from: "A-01-1-01", to: "B-01", items: [{ id: rm1.id, qty: 1 }] })).status, 409, "товар не из той ячейки");
  assert.equal((await worker("POST", "/api/move", { from: "PRIEM", to: "B-01", items: [{ id: 999999, qty: 1 }] })).status, 409, "несуществующая строка");
  assert.equal((await stockOf(worker, "PRIEM", "RM-1"))[0].qty, 15, "после ошибок остаток не изменился");
  assert.equal((await worker("POST", "/api/move", { from: "PRIEM", to: "в-01", items: [{ id: rm1.id, qty: 15 }] })).units, 15);
  assert.equal((await stockOf(worker, "PRIEM", "RM-1")).length, 0, "строка в приёмке исчезла целиком");
  assert.equal((await stockOf(worker, "B-01", "RM-1"))[0].qty, 15);
  const b = (await stockOf(worker, "B-01", "RM-1"))[0];
  assert.equal((await worker("POST", "/api/move", { from: "B-01", to: "B-02", items: [{ id: b.id, qty: 5 }] })).units, 5);
  const ops = (await worker("GET", "/api/data?parts=ops")).ops;
  assert.equal(ops[0].type, "move");
  assert.equal(ops[1].type, "putaway");
  assert.equal(ops[0].from_cell, "B-01");
});

test("кладовщик: сборка", async () => {
  const b1 = (await stockOf(worker, "B-01", "RM-1"))[0];
  assert.equal((await worker("POST", "/api/pick", { items: [] })).status, 400, "ничего не собрано");
  assert.equal((await worker("POST", "/api/pick", { items: [{ id: b1.id, qty: 11 }] })).status, 409, "собрать больше, чем есть");
  assert.equal((await worker("POST", "/api/pick", { items: [{ id: b1.id, qty: 6 }, { id: 999999, qty: 1 }] })).status, 409, "одна строка битая — откат всей сборки");
  assert.equal((await stockOf(worker, "B-01", "RM-1"))[0].qty, 10, "откат: ничего не списано");
  assert.equal((await worker("POST", "/api/pick", { doc: "Заказ 77", items: [{ id: b1.id, qty: 10 }] })).units, 10);
  assert.equal((await stockOf(worker, "B-01", "RM-1")).length, 0);
  assert.equal((await worker("POST", "/api/pick", { items: [{ id: b1.id, qty: 1 }] })).status, 409, "повторное списание той же строки");
});

test("кладовщик: инвентаризация", async () => {
  assert.equal((await worker("POST", "/api/inventory", { cell: "", lines: [] })).status, 400, "без ячейки");
  const r = await worker("POST", "/api/inventory", { cell: "B-02", lines: [{ client: "ООО Ромашка", article: "RM-1", counted: 5 }] });
  assert.equal(r.changed, 0, "совпало — без операций");
  assert.equal((await worker("POST", "/api/inventory", { cell: "B-02", lines: [{ client: "ООО Ромашка", article: "RM-1", counted: 3 }] })).changed, 1);
  assert.equal((await stockOf(worker, "B-02", "RM-1"))[0].qty, 3);
  assert.equal((await worker("POST", "/api/inventory", { cell: "B-02", lines: [{ client: "ООО Ромашка", article: "RM-1", counted: -2 }] })).changed, 0, "отрицательный счёт игнорируется");
  assert.equal((await worker("POST", "/api/inventory", { cell: "B-02", lines: [{ client: "ООО Ромашка", article: "RM-1", counted: 0 }] })).changed, 1);
  assert.equal((await stockOf(worker, "B-02", "RM-1")).length, 0, "ноль — строка удалена");
  // найденный при пересчёте товар без клиента нельзя положить «ничей»
  const orphan = await worker("POST", "/api/inventory", { cell: "B-02", lines: [{ client: "", article: "LOST-1", counted: 2 }] });
  assert.equal(orphan.status, 400, "излишек без клиента");
  assert.equal((await stockOf(worker, "B-02", "LOST-1")).length, 0);
  assert.equal((await worker("POST", "/api/inventory", { cell: "B-02", lines: [{ client: "ИП Петров", article: "PT-9", name: "Найдено", counted: 2 }] })).changed, 1, "излишек с клиентом");
  const op = (await worker("GET", "/api/data?parts=ops")).ops[0];
  assert.equal(op.type, "inventory");
  assert.equal(op.note, "учёт 0, факт 2");
});

test("права: кладовщик без «остатков» и сотрудник без «операций»", async () => {
  assert.equal((await worker("POST", "/api/products", { client: "ИП Петров", article: "X" })).status, 403, "ivan: нет права на справочник");
  assert.equal((await worker("POST", "/api/adjust", { mode: "delta", cell: "A", client: "К", article: "X", delta: 1 })).status, 403);
  assert.equal((await worker("POST", "/api/import-stock", { rows: [] })).status, 403);
  assert.equal((await worker("GET", "/api/billing/summary")).status, 403);
  assert.equal((await worker("GET", "/api/team")).status, 403);
  assert.equal((await viewer("POST", "/api/receive", { client: "К", lines: [{ article: "A", got: 1 }] })).status, 403, "olga: нет права на операции");
  assert.equal((await viewer("POST", "/api/pick", { items: [{ id: 1, qty: 1 }] })).status, 403);
  assert.ok(Array.isArray((await viewer("GET", "/api/data?parts=stock")).stock), "olga видит остатки");
  assert.equal((await viewer("POST", "/api/products", { client: "ИП Петров", article: "PT-1", name: "Чехол силиконовый" })).ok, true);
  assert.ok((await viewer("GET", "/api/cabinet?month=2026-10")).salary, "у каждого сотрудника есть свой кабинет");
});

test("администратор: ручная корректировка", async () => {
  assert.equal((await admin("POST", "/api/adjust", { mode: "delta", cell: "", client: "К", article: "X", delta: 1 })).status, 400, "без ячейки");
  assert.equal((await admin("POST", "/api/adjust", { mode: "delta", cell: "C-01", client: "К", article: "", delta: 1 })).status, 400, "без артикула");
  assert.equal((await admin("POST", "/api/adjust", { mode: "delta", cell: "C-01", client: "К", article: "X", delta: 0 })).status, 400, "ноль");
  assert.equal((await admin("POST", "/api/adjust", { mode: "delta", cell: "C-01", client: "", article: "X", delta: 3 })).status, 400, "без клиента");
  assert.equal((await admin("POST", "/api/adjust", { mode: "delta", cell: "C-01", client: "ИП Петров", article: "PT-1", delta: -1 })).status, 409, "списать из пустой ячейки");
  assert.equal((await admin("POST", "/api/adjust", { mode: "delta", cell: "C-01", client: "ИП Петров", article: "PT-1", name: "Чехол", delta: 3 })).ok, true);
  const row = (await stockOf(admin, "C-01", "PT-1"))[0];
  assert.equal((await admin("POST", "/api/adjust", { mode: "set", id: row.id, qty: -1 })).status, 400, "отрицательный остаток");
  assert.equal((await admin("POST", "/api/adjust", { mode: "set", id: row.id, qty: 7 })).ok, true);
  assert.equal((await stockOf(admin, "C-01", "PT-1"))[0].qty, 7);
  assert.equal((await admin("POST", "/api/adjust", { mode: "delete", id: row.id })).ok, true);
  assert.equal((await stockOf(admin, "C-01", "PT-1")).length, 0);
  assert.equal((await admin("POST", "/api/adjust", { mode: "delete", id: row.id })).status, 409, "повторное удаление");
  assert.equal((await admin("POST", "/api/adjust", { mode: "zzz" })).status, 400);
  const notes = (await admin("GET", "/api/data?parts=ops")).ops.slice(0, 3).map(o => o.note);
  assert.deepEqual(notes, ["строка удалена", "ручная корректировка", "ручная корректировка"]);
});

test("администратор: загрузка раскладки из файла", async () => {
  const before = units(await stockOf(admin));
  const r = await admin("POST", "/api/import-stock", { file: "раскладка.xlsx", rows: [
    { cell: "D-01", client: "ИП Петров", article: "PT-1", qty: 2 },
    { cell: "D-01", client: "", article: "NOBODY", qty: 2 },
    { cell: "", client: "ИП Петров", article: "PT-1", qty: 2 },
    { cell: "D-01", client: "ИП Петров", article: "PT-1", qty: 0 },
    { cell: "D-01", client: "ИП Петров", article: "PT-1", qty: "abc" },
  ] });
  assert.equal(r.ok, 1, "принята только корректная строка");
  assert.equal(r.skipped, 4, "отброшенные строки посчитаны");
  assert.equal(units(await stockOf(admin)) - before, 2);
  assert.equal((await stockOf(admin, "D-01", "NOBODY")).length, 0, "товар без клиента не заводится");
  // штрихкод, уже занятый другим товаром, не теряется молча
  const c = await admin("POST", "/api/import-stock", { file: "x.xlsx", rows: [{ cell: "D-02", client: "ИП Петров", article: "PT-3", qty: 1, barcode: "4600000000024" }] });
  assert.equal(c.skippedBc, 1);
  assert.ok(Array.isArray(c.conflicts) && c.conflicts[0].barcode === "4600000000024", "ответ говорит, какой штрихкод и почему пропущен");
  assert.equal(c.conflicts[0].owner, "RM-2 (ООО Ромашка)");
  assert.equal((await admin("POST", "/api/import-stock", { rows: new Array(20001).fill({}) })).status, 400, "слишком большой файл");
});

test("администратор: справочник товаров", async () => {
  assert.equal((await admin("POST", "/api/products", { client: "", article: "X" })).status, 400);
  assert.equal((await admin("POST", "/api/products", { client: "ИП Петров", article: "PT-1", name: "Чехол", barcodes: "4600000000048, 4600000000055" })).ok, true);
  let p = (await admin("GET", "/api/data?parts=products")).products.find(x => x.article === "PT-1");
  assert.deepEqual(p.barcodes, ["4600000000048", "4600000000055"], "строка через запятую — два штрихкода");
  assert.equal((await admin("POST", "/api/products", { client: "ИП Петров", article: "PT-1", barcodes: [] })).ok, true);
  p = (await admin("GET", "/api/data?parts=products")).products.find(x => x.article === "PT-1");
  assert.deepEqual(p.barcodes, [], "сохранение карточки заменяет штрихкоды");
  assert.equal(p.name, "Чехол", "пустое название не стирает старое");
  const bulk = await admin("POST", "/api/products/bulk", { rows: [{ client: "ИП Петров", article: "PT-5", name: "Новый", barcode: "4600000000062" }, { client: "ИП Петров", article: "PT-6", barcode: "4600000000062" }] });
  assert.equal(bulk.ok, 2);
  assert.equal(bulk.skippedBc, 1, "второй раз тот же штрихкод не привязывается");
});

test("администратор: ячейки", async () => {
  assert.equal((await admin("POST", "/api/cells", { cells: ["e-01-1-01", "E-01-1-01", " е-01-1-02 ", ""] })).ok, 3);
  const cells = (await admin("GET", "/api/data?parts=cells")).cells;
  assert.ok(cells.includes("E-01-1-01") && cells.includes("E-01-1-02"));
  assert.equal(cells.filter(c => c === "E-01-1-01").length, 1, "без дублей");
  assert.equal((await admin("POST", "/api/cells", { cells: new Array(5001).fill("Z") })).status, 400);
  assert.equal((await worker("POST", "/api/cells/delete", { cells: ["E-01-1-01"] })).status, 403, "кладовщик не удаляет ячейки");
  assert.equal((await admin("POST", "/api/cells/delete", { cells: ["A-01-1-01"] })).ok, 0, "занятая ячейка не удаляется");
  assert.equal((await admin("POST", "/api/cells/delete", { cells: ["E-01-1-02"] })).ok, 1);
});

test("администратор: сотрудники — изменение прав, отключение, сброс пароля", async () => {
  const { users } = await admin("GET", "/api/users");
  const ivan = users.find(u => u.login === "ivan");
  assert.equal((await admin("POST", "/api/users/update", { id: ivan.id, perms: "ops,stock" })).ok, true);
  assert.equal((await worker("POST", "/api/products", { client: "ИП Петров", article: "PT-7" })).ok, true, "новое право действует без перезахода");
  assert.equal((await admin("POST", "/api/users/update", { id: ivan.id, password: "abc" })).status, 400, "короткий новый пароль");
  assert.equal((await admin("POST", "/api/users/update", { id: ivan.id, password: "newpass1" })).ok, true);
  assert.equal((await anon("POST", "/api/login", { login: "ivan", password: "newpass1" })).ok, true);
  assert.equal((await admin("POST", "/api/users/update", { id: ivan.id, active: false })).ok, true);
  assert.equal((await worker("GET", "/api/data")).status, 401, "отключённый сразу теряет доступ");
  assert.equal((await anon("POST", "/api/login", { login: "ivan", password: "newpass1" })).status, 401);
  assert.equal((await admin("POST", "/api/users/update", { id: ivan.id, active: true })).ok, true);
  assert.equal((await worker("POST", "/api/login", { login: "ivan", password: "newpass1" })).ok, true);
  assert.equal((await admin("POST", "/api/users/update", { id: 99999, active: false })).status, 400);
});

test("клиент: кабинет, границы доступа, смена пароля", async () => {
  assert.equal((await admin("POST", "/api/users", { login: "romashka", name: "Ромашка", password: "client1", role: "client", client: "ООО Ромашка" })).ok, true);
  assert.equal((await client("POST", "/api/login", { login: "romashka", password: "client1" })).ok, true);
  const my = await client("GET", "/api/my");
  assert.equal(my.client, "ООО Ромашка");
  assert.deepEqual(my.stock.map(s => s.article).sort(), ["RM-2"], "видит только свой товар");
  assert.ok(my.ops.length > 0);
  assert.ok(!my.ops.some(o => o.type === "move" || o.type === "putaway"), "внутренние перемещения склада не показываются");
  assert.ok(my.ops.some(o => o.type === "pick" && o.doc === "Заказ 77"), "отгрузка видна с номером заказа");
  assert.equal((await client("GET", "/api/data")).status, 403);
  assert.equal((await client("GET", "/api/cabinet?month=2026-10")).status, 403, "кабинет сотрудника клиенту закрыт");
  assert.equal((await client("GET", "/api/billing/summary")).status, 403);
  assert.equal((await client("POST", "/api/password", { old: "client1", password: "newpass1" })).status, 403, "без разрешения склада пароль не меняется");
  const bill = await client("GET", "/api/billing/invoices");
  assert.ok(Array.isArray(bill.invoices));
  assert.equal((await client("GET", "/api/billing/invoice?id=1")).status, 404, "чужой или несуществующий счёт");
});

test("администратор: кабинет клиента глазами склада и переименование", async () => {
  const pv = await admin("GET", "/api/my?client=" + encodeURIComponent("ооо ромашка"));
  assert.equal(pv.client, "ООО Ромашка");
  const cl = await admin("GET", "/api/clients");
  assert.ok(cl.clients.some(c => c.name === "ООО Ромашка" && c.accounts.length === 1));
  assert.equal((await admin("POST", "/api/clients/rename", { from: "ООО Ромашка", to: "" })).status, 400);
  assert.equal((await admin("POST", "/api/clients/rename", { from: "ООО Ромашка", to: "ООО «Ромашка»" })).ok, true);
  const my = await client("GET", "/api/my");
  assert.equal(my.client, "ООО «Ромашка»", "логин клиента переехал вместе с товаром");
  assert.equal(my.stock.length, 1);
});

test("журнал и сводка сходятся с остатками", async () => {
  const d = await admin("GET", "/api/data?parts=stock,ops");
  const byKey = new Map();
  for (const o of d.ops) {
    if (o.type === "move" || o.type === "putaway") continue;
    const sign = o.type === "pick" ? -1 : 1;
    const k = o.client.toLowerCase().replace(/[«»]/g, "") + "|" + o.article.toLowerCase();
    byKey.set(k, (byKey.get(k) || 0) + sign * o.qty);
  }
  const st = new Map();
  for (const s of d.stock) { const k = s.client.toLowerCase().replace(/[«»]/g, "") + "|" + s.article.toLowerCase(); st.set(k, (st.get(k) || 0) + s.qty); }
  for (const [k, v] of st) assert.equal(byKey.get(k), v, "журнал = остаток: " + k);
  assert.ok(d.stock.every(s => s.qty > 0), "нулевых строк нет");
  assert.ok(d.stock.every(s => s.client.trim()), "ничейных строк нет");
});

test("безопасность: вход без сессии, чужие сессии, HTML в названиях", async () => {
  for (const u of ["/api/data", "/api/my", "/api/users", "/api/cabinet", "/api/billing/charges"]) assert.equal((await anon("GET", u)).status, 401, u);
  assert.equal((await worker("POST", "/api/receive", { client: "<img src=x onerror=alert(1)>", lines: [{ article: "<b>X</b>", got: 1 }] })).ok, true, "любой текст сохраняется как есть");
  const r = await fetch(base + "/", {});
  const csp = r.headers.get("content-security-policy") || "";
  assert.ok(/script-src[^;]*'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), "встроенные скрипты запрещены политикой");
  const s = await fetch(base + "/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.ok(s.status < 500);
});

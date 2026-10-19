"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sklad-billing-"));
const { server, db } = require("../server.js");
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

const admin = agent(), worker = agent(), client = agent(), other = agent();
const C = "ООО Тест";
const day = (shift = 0) => new Date(Date.now() + 3 * 3600e3 + shift * 864e5).toISOString().slice(0, 10);
const q = s => encodeURIComponent(s);
let svc;

test("подготовка: пользователи и тарифы по умолчанию", async () => {
  await admin("POST", "/api/setup", { login: "boss", name: "Хозяин", password: "secret1" });
  await admin("POST", "/api/users", { login: "ivan", name: "Иван", password: "123456", role: "worker" });
  await admin("POST", "/api/users", { login: "test", name: "Тест", password: "client1", role: "client", client: C });
  await admin("POST", "/api/users", { login: "other", name: "Другой", password: "client2", role: "client", client: "ИП Чужой" });
  await worker("POST", "/api/login", { login: "ivan", password: "123456" });
  await client("POST", "/api/login", { login: "test", password: "client1" });
  await other("POST", "/api/login", { login: "other", password: "client2" });
  const { services } = await worker("GET", "/api/billing/services");
  svc = Object.fromEntries(services.map(s => [s.code, s]));
  assert.deepEqual(Object.keys(svc).sort(), ["DELIVERY", "LABEL", "PACK", "PICK", "RECEIVE", "STORAGE"]);
  assert.equal(svc.RECEIVE.kind, "receive");
});

test("приёмка и сборка начисляются сами, ручные услуги добавляет кладовщик", async () => {
  await worker("POST", "/api/receive", { client: C, doc: "П-1", lines: [{ article: "A", got: 6 }, { article: "B", got: 4 }] });
  const st = (await worker("GET", "/api/data?parts=stock")).stock.find(s => s.article === "A");
  await worker("POST", "/api/move", { from: "PRIEM", to: "A-01", items: [{ id: st.id, qty: 6 }] });
  const placed = (await worker("GET", "/api/data?parts=stock")).stock.find(s => s.cell === "A-01");
  await worker("POST", "/api/pick", { doc: "WB-1", items: [{ id: placed.id, qty: 4 }] });
  assert.equal((await worker("POST", "/api/billing/charges", { client: C, service_id: svc.PACK.id, qty: 4, note: "упаковка WB-1" })).ok, true);
  assert.equal((await worker("POST", "/api/billing/charges", { client: C, service_id: svc.STORAGE.id, qty: 1 })).status, 400, "хранение вручную нельзя");
  assert.equal((await worker("POST", "/api/billing/charges", { client: C, service_id: svc.PACK.id, qty: 0 })).status, 400);

  const { charges } = await worker("GET", "/api/billing/charges?client=" + q(C));
  const by = Object.fromEntries(charges.map(c => [c.service, c]));
  assert.equal(by["Приёмка товара"].qty, 10);
  assert.equal(by["Приёмка товара"].amount, 50);
  assert.equal(by["Приёмка товара"].note, "Приёмка П-1");
  assert.equal(by["Сборка и отгрузка"].amount, 60);
  assert.equal(by["Упаковка"].amount, 40);
  assert.ok(charges.every(c => c.day === day() && !c.invoice_id));
});

test("индивидуальная цена клиента применяется к новым начислениям", async () => {
  assert.equal((await worker("POST", "/api/billing/prices", { client: C, service_id: svc.RECEIVE.id, price: 4 })).status, 403);
  assert.equal((await admin("POST", "/api/billing/prices", { client: "ооо  тест", service_id: svc.RECEIVE.id, price: "4" })).ok, true);
  await worker("POST", "/api/receive", { client: C, doc: "П-2", lines: [{ article: "B", got: 5 }] });
  const { charges } = await admin("GET", "/api/billing/charges?client=" + q(C));
  const p2 = charges.find(c => c.note === "Приёмка П-2");
  assert.equal(p2.price, 4);
  assert.equal(p2.amount, 20);
  const { prices } = await admin("GET", "/api/billing/prices?client=" + q(C));
  assert.equal(prices.find(p => p.service_id === svc.RECEIVE.id).client_price, 4);
});

test("хранение считается по остаткам на конец каждых суток", async () => {
  // у клиента 10 шт. уже 5 дней: 6 суток (5 дней назад … сегодня) × 10 шт.
  const H = "ИП Хранение";
  await admin("POST", "/api/adjust", { mode: "delta", cell: "S-01", client: H, article: "X", delta: 10 });
  db.prepare("UPDATE ops SET ts=? WHERE client=?").run(new Date(Date.now() - 5 * 864e5).toISOString(), H);
  let p = await admin("GET", `/api/billing/preview?client=${q(H)}&from=${day(-7)}&to=${day()}`);
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0].qty, 60);
  assert.equal(p.total, 30);
  // отгрузили 4 шт. сегодня: сегодня на складе 6, остальные дни по 10
  const row = (await admin("GET", "/api/data?parts=stock")).stock.find(s => s.client === H);
  await admin("POST", "/api/pick", { items: [{ id: row.id, qty: 4 }] });
  p = await admin("GET", `/api/billing/preview?client=${q(H)}&from=${day(-7)}&to=${day(-1)}`);
  assert.equal(p.lines[0].qty, 50, "вчерашние дни не зависят от сегодняшней отгрузки");
});

test("счёт: предпросмотр, выставление, повтор, отмена, оплата", async () => {
  // 50 + 60 + 40 + 20 + хранение: 10 − 4 + 5 = 11 шт. на конец дня × 0,5 = 5,5
  const prev = await admin("GET", `/api/billing/preview?client=${q(C)}&from=${day(-30)}&to=${day()}`);
  assert.equal(prev.total, 175.5);
  assert.equal(prev.storage.qty, 11);
  assert.equal((await worker("POST", "/api/billing/invoices", { client: C, from: day(-30), to: day() })).status, 403);
  const inv = await admin("POST", "/api/billing/invoices", { client: C, from: day(-30), to: day() });
  assert.equal(inv.total, 175.5);
  assert.match(inv.number, /^\d{4}-0001$/);
  assert.equal((await admin("POST", "/api/billing/invoices", { client: C, from: day(-30), to: day() })).status, 400, "повторно выставить нечего");

  const { charges } = await admin("GET", "/api/billing/charges?client=" + q(C));
  assert.equal((await admin("POST", "/api/billing/charges/delete", { id: charges[0].id })).status, 409);

  const full = await admin("GET", "/api/billing/invoice?id=" + inv.id);
  assert.equal(full.invoice.lines.reduce((a, l) => a + l.amount, 0), 175.5);
  assert.equal(full.supplier.vat_note, "Без НДС");
  assert.ok(!("ckey" in full.invoice));

  assert.equal((await admin("POST", "/api/billing/invoices/status", { id: inv.id, action: "cancel" })).ok, true);
  assert.equal((await admin("GET", `/api/billing/preview?client=${q(C)}&from=${day(-30)}&to=${day()}`)).total, 175.5, "после отмены услуги снова свободны");
  const inv2 = await admin("POST", "/api/billing/invoices", { client: C, from: day(-30), to: day() });
  assert.match(inv2.number, /-0002$/);
  assert.equal((await admin("POST", "/api/billing/invoices/status", { id: inv2.id, action: "paid" })).ok, true);
  assert.equal((await admin("POST", "/api/billing/invoices/status", { id: inv.id, action: "paid" })).status, 409, "отменённый счёт не оплачивают");

  const s = await admin("GET", "/api/billing/summary");
  assert.equal(s.unpaid, 0);
  assert.equal(s.open, 60, "не выставлена только сборка «ИП Хранение»: 4 шт. × 15");
  assert.equal(s.month, 235.5);
});

test("кабинет клиента: только свои счета и услуги, менять ничего нельзя", async () => {
  const mine = await client("GET", "/api/billing/invoices");
  assert.equal(mine.invoices.length, 1, "отменённый счёт клиенту не показывается");
  assert.equal(mine.invoices[0].status, "paid");
  const spoof = await client("GET", "/api/billing/invoices?client=" + q("ИП Хранение"));
  assert.equal(spoof.invoices.length, 1);
  assert.ok((await client("GET", "/api/billing/charges")).charges.every(c => c.client === C && !("user_name" in c)));
  assert.equal((await other("GET", "/api/billing/invoice?id=" + mine.invoices[0].id)).status, 404);
  assert.equal((await other("GET", "/api/billing/invoices")).invoices.length, 0);
  for (const [m, u, b] of [
    ["GET", "/api/billing/services"], ["GET", "/api/billing/preview"], ["GET", "/api/billing/summary"], ["GET", "/api/billing/settings"],
    ["POST", "/api/billing/charges", { client: C, service_id: 1, qty: 1 }], ["POST", "/api/billing/invoices", {}],
    ["POST", "/api/billing/invoices/status", { id: 1, action: "cancel" }], ["POST", "/api/billing/services/update", { id: 1, price: 0 }],
    ["POST", "/api/billing/settings", { company_name: "x" }], ["POST", "/api/billing/charges/delete", { id: 1 }],
  ]) assert.equal((await client(m, u, b)).status, 403, u);
});

test("тарифы и реквизиты: правка, проверка значений", async () => {
  assert.equal((await admin("POST", "/api/billing/services/update", { id: svc.PACK.id, price: -1 })).status, 400);
  assert.equal((await admin("POST", "/api/billing/services/update", { id: svc.PACK.id, price: "12,5" })).ok, true);
  assert.equal((await admin("POST", "/api/billing/services", { name: "Фото товара", unit: "шт", price: 50 })).ok, true);
  const { services } = await admin("GET", "/api/billing/services");
  assert.equal(services.find(s => s.code === "PACK").price, 12.5);
  assert.ok(services.some(s => s.name === "Фото товара" && s.kind === "manual"));
  assert.equal((await admin("POST", "/api/billing/settings", { company_name: "ИП Склад", company_inn: "3600000000", junk: "x" })).ok, true);
  const { settings } = await admin("GET", "/api/billing/settings");
  assert.equal(settings.company_name, "ИП Склад");
  assert.ok(!("junk" in settings));
  assert.equal((await admin("GET", `/api/billing/preview?client=${q(C)}&from=2026-02-30&to=${day()}`)).status, 400);
  assert.equal((await admin("GET", `/api/billing/preview?client=${q(C)}&from=${day()}&to=${day(-1)}`)).status, 400);
});

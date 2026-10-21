"use strict";
/* Версия 1.3: права сотрудников, график и зарплата, штрафы, кабинет сотрудника, клиенты с подразделениями, расчётные счета */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sklad-team-"));
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

const admin = agent(), packer = agent(), boss = agent(), loner = agent(), client = agent();
const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10), month = today.slice(0, 7);
let ids = {};

test("сотрудники с правами, оклад и подразделения", async () => {
  await admin("POST", "/api/setup", { login: "admin", name: "Админ", password: "secret1" });
  ids.packer = (await admin("POST", "/api/users", { login: "packer", name: "Пётр", password: "123456", role: "worker", perms: ["ops"], dept: "Сборка", rate: 2500 })).id;
  ids.boss = (await admin("POST", "/api/users", { login: "boss", name: "Борис", password: "123456", role: "worker", perms: ["team", "stock"], dept: "Склад", manage_depts: ["Сборка"], rate: 4000 })).id;
  ids.loner = (await admin("POST", "/api/users", { login: "loner", name: "Лев", password: "123456", role: "worker", perms: [], dept: "Приёмка", rate: 2000 })).id;
  for (const [a, l] of [[packer, "packer"], [boss, "boss"], [loner, "loner"]]) assert.equal((await a("POST", "/api/login", { login: l, password: "123456" })).ok, true);

  const me = await packer("GET", "/api/me");
  assert.deepEqual(me.user.perms, ["ops"]);
  // права проверяет сервер, а не только интерфейс
  assert.equal((await packer("POST", "/api/receive", { client: "ООО А", lines: [{ article: "X", got: 3 }] })).ok, true);
  assert.equal((await packer("POST", "/api/products", { client: "ООО А", article: "Y" })).status, 403, "нет права «остатки и справочники»");
  assert.equal((await packer("GET", "/api/billing/services")).status, 403, "нет права «услуги»");
  assert.equal((await packer("GET", "/api/team?month=" + month)).status, 403, "не руководитель");
  assert.equal((await loner("GET", "/api/data")).status, 403, "без прав видит только свой кабинет");
  assert.equal((await loner("GET", "/api/cabinet?month=" + month)).name, "Лев");
  assert.equal((await boss("POST", "/api/pick", { items: [{ id: 1, qty: 1 }] })).status, 403);
});

test("график: руководитель видит только своё подразделение", async () => {
  const t = await boss("GET", "/api/team?month=" + month);
  assert.deepEqual(t.users.map(u => u.name), ["Пётр"], "Борис управляет «Сборкой» и не правит сам себя");
  assert.equal((await boss("POST", "/api/team/shift", { user_id: ids.loner, day: today, status: "done" })).status, 403);
  assert.equal((await boss("POST", "/api/team/shift", { user_id: ids.boss, day: today, status: "done" })).status, 403);
  assert.equal((await admin("GET", "/api/team?month=" + month)).users.length, 4, "администратор видит всех, включая себя");
});

test("смены, автоотметка по операциям, шаблон 5/2, штрафы и премии, зарплата", async () => {
  // Пётр провёл приёмку сегодня → автоотметка ставит ему отработанную смену
  const af = await boss("POST", "/api/team/autofill", { month });
  assert.equal(af.marked, 1);
  let t = await boss("GET", "/api/team?month=" + month);
  assert.equal(t.shifts.find(s => s.day === today).status, "done");
  assert.equal(t.activity[ids.packer][today], 1);

  const p = await boss("POST", "/api/team/pattern", { user_id: ids.packer, month, pattern: "5/2" });
  assert.ok(p.planned >= 15 && p.planned <= 23);
  t = await boss("GET", "/api/team?month=" + month);
  assert.equal(t.shifts.find(s => s.day === today).status, "done", "шаблон не затирает отработанную смену");

  // оклад меняется — уже отработанная смена считается по старой ставке
  await admin("POST", "/api/users/update", { id: ids.packer, rate: 3000 });
  const other = month + (today.slice(8) === "01" ? "-02" : "-01");
  await boss("POST", "/api/team/shift", { user_id: ids.packer, day: other, status: "done" });
  await boss("POST", "/api/team/fine", { user_id: ids.packer, day: today, kind: "fine", amount: 500, reason: "Опоздание" });
  await boss("POST", "/api/team/fine", { user_id: ids.packer, day: today, kind: "bonus", amount: 1000, reason: "План перевыполнен" });
  assert.equal((await boss("POST", "/api/team/fine", { user_id: ids.packer, day: today, amount: 0, reason: "x" })).status, 400);
  assert.equal((await boss("POST", "/api/team/fine", { user_id: ids.packer, day: today, amount: 10 })).status, 400, "без причины нельзя");

  t = await boss("GET", "/api/team?month=" + month);
  const sal = t.salary.find(s => s.user_id === ids.packer);
  assert.deepEqual({ done: sal.done, base: sal.base, fines: sal.fines, bonuses: sal.bonuses, total: sal.total },
    { done: 2, base: 5500, fines: 500, bonuses: 1000, total: 6000 });

  // сотрудник видит своё в кабинете, но менять не может
  const cab = await packer("GET", "/api/cabinet?month=" + month);
  assert.equal(cab.salary.total, 6000);
  assert.equal(cab.fines.length, 2);
  assert.equal(cab.ops.length, 1);
  assert.equal(cab.ops[0].type, "receive");
  assert.equal((await packer("POST", "/api/team/fine/delete", { id: cab.fines[0].id })).status, 403);
  assert.equal((await boss("POST", "/api/team/fine/delete", { id: cab.fines[0].id })).ok, true);
});

test("расчётные счета, клиенты, подразделения и логины", async () => {
  const b1 = await admin("POST", "/api/banks", { title: "Сбер", bank_name: "ПАО Сбербанк", bik: "044525225", account: "40802810000000000001", corr_account: "30101810400000000225" });
  const b2 = await admin("POST", "/api/banks", { title: "Тинькофф", bank_name: "АО Т-Банк", bik: "044525974", account: "40802810000000000002" });
  assert.equal((await admin("POST", "/api/banks", { bank_name: "X", account: "123" })).status, 400, "счёт — 20 цифр");
  assert.equal((await admin("POST", "/api/banks/delete", { id: b1.id })).status, 409, "основной не удалить");

  assert.equal((await admin("POST", "/api/clients", { name: "ООО А", inn: "7707083893", kpp: "773601001", address: "Москва" })).ok, true);
  assert.equal((await admin("POST", "/api/clients", { name: "ООО А", inn: "123" })).status, 400);
  const s1 = await admin("POST", "/api/clients/sub", { client: "ООО А", name: "Магазин WB", bank_id: b2.id });
  const s2 = await admin("POST", "/api/clients/sub", { client: "ООО А", name: "Магазин Ozon" });
  const acc = await admin("POST", "/api/users", { login: "a-wb", name: "Анна", password: "client1", role: "client", client: "ООО А", sub_id: s1.id });
  assert.equal(acc.ok, true);
  assert.equal((await admin("POST", "/api/users", { login: "a-x", name: "X", password: "client1", role: "client", client: "ООО Б", sub_id: s1.id })).status, 400, "подразделение чужого клиента");

  const cl = await admin("GET", "/api/clients");
  const a = cl.clients.find(c => c.name === "ООО А");
  assert.equal(a.subs.length, 2);
  assert.equal(a.accounts[0].login, "a-wb");
  assert.equal(a.accounts[0].can_change_pw, 0, "клиенту пароль выдаёт склад");

  await client("POST", "/api/login", { login: "a-wb", password: "client1" });
  assert.equal((await client("POST", "/api/password", { old: "client1", password: "newpass1" })).status, 403);
  assert.equal((await client("GET", "/api/team?month=" + month)).status, 403);
  assert.equal((await client("GET", "/api/cabinet?month=" + month)).status, 403);
  assert.equal((await client("GET", "/api/clients")).status, 403);

  // счёт на подразделение берёт его расчётный счёт и запоминает реквизиты
  await admin("POST", "/api/billing/settings", { company_name: "ИП Тестов", company_inn: "366200000000", director: "Тестов Т. Т.", dadata_key: "секрет" });
  await admin("POST", "/api/billing/charges", { client: "ООО А", service_id: 4, qty: 2 });
  const inv = await admin("POST", "/api/billing/invoices", { client: "ООО А", sub_id: s1.id, from: today, to: today });
  assert.equal(inv.ok, true);
  const full = await admin("GET", "/api/billing/invoice?id=" + inv.id);
  assert.equal(full.doc.bank.account, "40802810000000000002");
  assert.equal(full.doc.payer.sub, "Магазин WB");
  assert.equal(full.doc.payer.inn, "7707083893");
  assert.ok(!JSON.stringify(full).includes("секрет"), "ключ DaData не уходит в документы");
  await admin("POST", "/api/banks", { id: b2.id, title: "Т", bank_name: "Другой банк", bik: "044525974", account: "40802810000000000009" });
  assert.equal((await admin("GET", "/api/billing/invoice?id=" + inv.id)).doc.bank.account, "40802810000000000002", "выставленный счёт не меняется");

  // логин подразделения видит счёт своего подразделения; второго подразделения — нет
  assert.equal((await client("GET", "/api/billing/invoices")).invoices.length, 1);
  await admin("POST", "/api/users", { login: "a-oz", name: "Олег", password: "client2", role: "client", client: "ООО А", sub_id: s2.id });
  const oz = agent();
  await oz("POST", "/api/login", { login: "a-oz", password: "client2" });
  assert.equal((await oz("GET", "/api/billing/invoices")).invoices.length, 0);
  assert.equal((await oz("GET", "/api/billing/invoice?id=" + inv.id)).status, 404);

  assert.equal((await admin("POST", "/api/clients/sub/delete", { id: s1.id })).ok, true);
  const after = (await admin("GET", "/api/clients")).clients.find(c => c.name === "ООО А");
  assert.equal(after.accounts.find(x => x.login === "a-wb").sub_id, null, "логин остаётся, отвязывается от удалённого подразделения");
});

test("печать и подпись: только PNG, в счёт попадают, в настройки клиенту — нет", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  assert.equal((await admin("POST", "/api/billing/settings", { stamp_png: "data:text/html;base64,PHNjcmlwdD4=" })).status, 400);
  assert.equal((await admin("POST", "/api/billing/settings", { stamp_png: png, sign_png: png })).ok, true);
  const inv = (await admin("GET", "/api/billing/invoices")).invoices[0];
  const full = await admin("GET", "/api/billing/invoice?id=" + inv.id);
  assert.equal(full.stamp, png);
  assert.equal(full.sign, png);
  assert.equal((await client("GET", "/api/billing/settings")).status, 403);
});

test("поиск по ИНН без ключа объясняет, что делать", async () => {
  await admin("POST", "/api/billing/settings", { dadata_key: "" });
  const r = await admin("GET", "/api/lookup/party?inn=7707083893");
  assert.equal(r.status, 400);
  assert.match(r.error, /DaData/);
  assert.equal((await admin("GET", "/api/lookup/party?inn=12")).status, 400);
  assert.equal((await packer("GET", "/api/lookup/party?inn=7707083893")).status, 403);
});

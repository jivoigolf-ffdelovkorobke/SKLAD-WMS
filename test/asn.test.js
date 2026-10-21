"use strict";
/* Заявки на поставку: клиент загружает список отправленного, склад принимает по нему, оба видят остаток. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sklad-asn-"));
const { server } = require("../server.js");
let base;
function agent() {
  let cookie = "";
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const j = await r.json().catch(() => null);
    return { status: r.status, ...j };
  };
}
before(() => new Promise(ok => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; ok(); })));
after(() => new Promise(ok => server.close(ok)));
const admin = agent(), worker = agent(), chip = agent(), other = agent();

test("подготовка: склад, клиенты, известный товар", async () => {
  await admin("POST", "/api/setup", { login: "boss", name: "Хозяин", password: "secret1" });
  await admin("POST", "/api/users", { login: "ivan", name: "Иван", password: "123456", role: "worker", perms: "ops" });
  await admin("POST", "/api/users", { login: "chip", name: "Чипчиков", password: "123456", role: "client", client: "ИП Чипчиков Р." });
  await admin("POST", "/api/users", { login: "other", name: "Другой", password: "123456", role: "client", client: "ИП Другой" });
  for (const [a, l] of [[worker, "ivan"], [chip, "chip"], [other, "other"]]) assert.equal((await a("POST", "/api/login", { login: l, password: "123456" })).ok, true);
  // у клиента уже есть «Пегги» с этим штрихкодом и «Лайза» без штрихкода
  await worker("POST", "/api/receive", { client: "ИП Чипчиков Р.", lines: [{ article: "71895/38", name: "Пегги черный", barcode: "4630114975664", got: 1 }, { article: "71653/26", name: "Лайза", got: 1 }] });
});

let asnId;
test("клиент загружает список отправленного", async () => {
  assert.equal((await chip("POST", "/api/asn", { title: "x", lines: [] })).status, 400, "пустой список");
  assert.equal((await chip("POST", "/api/asn", { lines: [{ name: "без кода", qty: 5 }] })).status, 400, "строки без штрихкода и артикула");
  const r = await chip("POST", "/api/asn", { title: "FBS Воронеж 16.10", client: "ИП Другой", lines: [
    { name: "Пегги WB 56-58 7189538   Черный", barcode: "4630114975664", qty: 10, box: "3" },
    { name: "Пегги WB 56-58 7189538   Черный", barcode: "4630114975664", qty: 47, box: "4" },
    { name: "Лайза * WB 56-58 7165326   Бледно-розовый", barcode: "4630105123593", qty: 54, box: "21" },
    { name: "Марлин WB 56-58 7158524   Молочный", barcode: "4630209608132", qty: 50, box: "56" },
    { name: "Брак", barcode: "4600000000000", qty: 0 },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.lines, 3, "две строки одного штрихкода из разных коробов — одна позиция");
  assert.equal(r.units, 161);
  assert.equal(r.unknown, 1, "Марлина в справочнике нет");
  asnId = r.id;
  const my = await chip("GET", "/api/my");
  const a = my.asn.find(x => x.id === asnId);
  assert.equal(a.client, "ИП Чипчиков Р.", "клиент не может подать заявку за другого");
  assert.equal(a.status, "new");
  assert.equal(a.boxes, 4);
  const peggy = a.lines.find(l => l.barcode === "4630114975664");
  assert.equal(peggy.article, "71895/38", "артикул взят из справочника по штрихкоду");
  assert.equal(peggy.name, "Пегги черный", "название из справочника склада");
  assert.deepEqual(peggy.boxes, ["3", "4"]);
  assert.equal(a.lines.find(l => l.barcode === "4630105123593").article, "71653/26", "по цифрам из наименования: 7165326 = 71653/26");
  assert.equal(a.lines.find(l => l.barcode === "4630209608132").article, "7158524", "незнакомая модель — цифры из наименования как есть");
  const n = await chip("POST", "/api/asn", { title: "Новый цвет", lines: [{ name: "Пегги WB 56-58 71895120   Пудровый", barcode: "4630114975596", qty: 2 }, { name: "Лайза * WB 56-58 7165325   Розовый", barcode: "4630105123630", qty: 1 }] });
  const na = (await chip("GET", "/api/my")).asn.find(x => x.id === n.id);
  assert.deepEqual(na.lines.map(l => l.article).sort(), ["71653/25", "71895/120"], "новый цвет известной модели — с дробью, как остальные артикулы");
  await chip("POST", "/api/asn/delete", { id: n.id });
  assert.ok(!(await other("GET", "/api/my")).asn.some(x => x.id === asnId), "чужой клиент заявку не видит");
});

test("склад видит заявку и принимает по ней частями", async () => {
  const d = await worker("GET", "/api/data?parts=asn");
  assert.ok(d.asn.some(x => x.id === asnId && x.status === "new"));
  assert.equal((await worker("POST", "/api/receive", { client: "ИП Другой", asn_id: asnId, lines: [{ article: "A", got: 1 }] })).status, 400, "заявка другого клиента");
  const r1 = await worker("POST", "/api/receive", { client: "ИП Чипчиков Р.", doc: "FBS Воронеж 16.10", asn_id: asnId, lines: [
    { article: "71895/38", barcode: "4630114975664", expected: 57, got: 57 },
    { article: "71653/26", barcode: "4630105123593", expected: 54, got: 20 },
    { article: "7158524", barcode: "4630209608132", expected: 50, got: 0 },
  ] });
  assert.equal(r1.ok, true);
  let a = (await chip("GET", "/api/my")).asn.find(x => x.id === asnId);
  assert.equal(a.status, "partial");
  assert.equal(a.got, 77);
  assert.equal(a.total, 161);
  assert.equal(a.lines.find(l => l.article === "71653/26").got, 20);
  // вторая приёмка добирает остаток, лишняя штука считается излишком, а не «принято больше 100 %»
  await worker("POST", "/api/receive", { client: "ИП Чипчиков Р.", asn_id: asnId, lines: [
    { article: "71653/26", barcode: "4630105123593", got: 34 }, { article: "7158524", barcode: "4630209608132", got: 51 }] });
  a = (await chip("GET", "/api/my")).asn.find(x => x.id === asnId);
  assert.equal(a.status, "done");
  assert.equal(a.got, 161);
  assert.equal(a.extra, 1);
  assert.equal(a.receipts.length, 2);
});

test("отзыв и закрытие заявки", async () => {
  assert.equal((await chip("POST", "/api/asn/delete", { id: asnId })).status, 409, "после приёмки отозвать нельзя");
  assert.equal((await other("POST", "/api/asn/delete", { id: asnId })).status, 404, "чужую заявку не видно");
  const r = await chip("POST", "/api/asn", { title: "Вторая", lines: [{ barcode: "4630114975664", qty: 5 }] });
  assert.equal((await chip("POST", "/api/asn/close", { id: r.id })).status, 403, "закрывает только склад");
  assert.equal((await worker("POST", "/api/asn/close", { id: r.id })).ok, true);
  assert.equal((await chip("GET", "/api/my")).asn.find(x => x.id === r.id).status, "closed");
  assert.equal((await worker("POST", "/api/receive", { client: "ИП Чипчиков Р.", asn_id: r.id, lines: [{ article: "71895/38", got: 1 }] })).status, 409, "по закрытой не принимают");
  assert.equal((await worker("POST", "/api/asn/close", { id: r.id, open: true })).ok, true);
  const r2 = await chip("POST", "/api/asn", { title: "Ошибочная", lines: [{ barcode: "4630114975664", qty: 1 }] });
  assert.equal((await chip("POST", "/api/asn/delete", { id: r2.id })).ok, true, "пока ничего не принято — клиент может отозвать");
  assert.ok(!(await chip("GET", "/api/my")).asn.some(x => x.id === r2.id));
  assert.equal((await worker("POST", "/api/asn", { lines: [{ barcode: "1", qty: 1 }] })).status, 400, "склад указывает клиента");
  assert.equal((await worker("POST", "/api/asn", { client: "ИП Чипчиков Р.", title: "За клиента", lines: [{ barcode: "1", article: "Z", qty: 1 }] })).ok, true, "склад может завести заявку за клиента");
});

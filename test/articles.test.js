"use strict";
/* Переименование артикула: латиница → кириллица, слияние с уже существующим артикулом, права. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sklad-art-"));
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
const admin = agent(), worker = agent();
const C = "ИП Сергеев В.В.";

test("переименование артикулов", async () => {
  assert.equal((await admin("POST", "/api/setup", { login: "boss", name: "Хозяин", password: "secret1" })).ok, true);
  assert.equal((await admin("POST", "/api/users", { login: "ivan", name: "Иван", password: "123456", role: "worker", perms: "ops,stock" })).ok, true);
  assert.equal((await worker("POST", "/api/login", { login: "ivan", password: "123456" })).ok, true);
  assert.equal((await worker("POST", "/api/receive", { client: C, doc: "11.11", lines: [
    { article: "KRM 210-01-02-01_H", name: "Елка 210", barcode: "111", got: 12, cell: "ELKA-01-1-01" },
    { article: "KRM 210-01-02-01_H", name: "Елка 210", got: 7, cell: "ELKA-01-1-02" },
    { article: "КРМ-210-01-02-01_Н", name: "Елка 210", barcode: "222", got: 2, cell: "ELKA-01-1-02" },
    { article: "ALPG-210", name: "Альпийская", got: 7, cell: "ELKA-01-1-09" },
  ] })).ok, true);

  assert.equal((await worker("POST", "/api/articles/rename", { client: C, from: "ALPG-210", to: "АЛПГ-210" })).status, 403, "только администратор");
  assert.equal((await admin("POST", "/api/articles/rename", { client: C, from: "NOPE", to: "X" })).status, 400, "нет такого артикула");
  assert.equal((await admin("POST", "/api/articles/rename", { client: C, from: "ALPG-210", to: "" })).status, 400, "пустой новый артикул");

  const r = await admin("POST", "/api/articles/rename", { client: C, pairs: [
    { from: "KRM 210-01-02-01_H", to: "КРМ-210-01-02-01_Н" }, { from: "ALPG-210", to: "АЛПГ-210" }] });
  assert.equal(r.ok, true);
  const d = await admin("GET", "/api/data?parts=stock,products,ops");
  const arts = new Set(d.stock.map(s => s.article));
  assert.deepEqual([...arts].sort(), ["АЛПГ-210", "КРМ-210-01-02-01_Н"]);
  const c2 = d.stock.filter(s => s.cell === "ELKA-01-1-02");
  assert.equal(c2.length, 1, "в одной ячейке старое и новое написание слились");
  assert.equal(c2[0].qty, 9);
  assert.equal(d.stock.reduce((a, s) => a + s.qty, 0), 28, "количество не потерялось");
  const p = d.products.filter(x => x.article === "КРМ-210-01-02-01_Н");
  assert.equal(p.length, 1);
  assert.deepEqual([...p[0].barcodes].sort(), ["111", "222"], "штрихкоды объединены");
  assert.ok(!d.products.some(x => /^(KRM|ALPG)/.test(x.article)), "латинских карточек не осталось");
  assert.ok(d.ops.every(o => !/^(KRM|ALPG)/.test(o.article)), "журнал тоже переименован");
});

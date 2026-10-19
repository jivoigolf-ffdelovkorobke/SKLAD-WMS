"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pub = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const js = fs.readFileSync(path.join(pub, "app.js"), "utf8");

/* app.js при запуске вешает обработчики на элементы страницы. Если элемента нет в index.html,
   скрипт падает целиком и приложение не открывается — поэтому сверяем все $("id") со страницей. */
test("каждый элемент, к которому обращается app.js, есть в index.html", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  // элементы, которые app.js создаёт сам: f.id="…" и разметка в шаблонах id="…"
  const created = new Set([...js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
  const used = new Set([...js.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map(m => m[1]));
  const missing = [...used].filter(id => !ids.has(id) && !created.has(id));
  assert.deepEqual(missing, [], "нет на странице: " + missing.join(", "));
});

test("версии файлов в index.html и кэше совпадают с package.json", () => {
  const v = require("../package.json").version;
  assert.ok(html.includes(`app.js?v=${v}`), "app.js?v=" + v);
  assert.ok(html.includes(`app.css?v=${v}`), "app.css?v=" + v);
  assert.match(fs.readFileSync(path.join(pub, "sw.js"), "utf8"), new RegExp(`sklad-v${v.split(".").slice(0, 2).join("\\.")}`));
});

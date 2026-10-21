/* Тестовые данные для локальной проверки (НЕ для боевого сервера).
   Запуск: PORT=8091 DATA_DIR=.localdata node server.js, затем node scripts/seed-local.js http://localhost:8091
   Логины: admin / admin123 (администратор), sklad / sklad123 (кладовщик), romashka / client123 (клиент «ООО Ромашка») */
"use strict";
const base = process.argv[2] || "http://localhost:8091";
function agent() {
  let cookie = "";
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${j && j.error}`);
    return j;
  };
}
(async () => {
  const a = agent();
  const me = await a("GET", "/api/me");
  if (me.needSetup) await a("POST", "/api/setup", { login: "admin", name: "Александр", password: "admin123" });
  else await a("POST", "/api/login", { login: "admin", password: "admin123" });
  const cells = [];
  for (const z of ["A", "B"]) for (let r = 1; r <= 2; r++) for (let t = 1; t <= 3; t++) for (let p = 1; p <= 4; p++) cells.push(`${z}-0${r}-${t}-0${p}`);
  await a("POST", "/api/cells", { cells });
  await a("POST", "/api/users", { login: "sklad", name: "Иван Кладовщик", password: "sklad123", role: "worker", perms: "ops,stock", dept: "Сборка", rate: 2500 });
  await a("POST", "/api/clients", { name: "ООО Ромашка" });
  await a("POST", "/api/users", { login: "romashka", name: "Ромашка", password: "client123", role: "client", client: "ООО Ромашка" });
  await a("POST", "/api/receive", { client: "ООО Ромашка", doc: "WB-001", cell: "PRIEM", lines: [
    { article: "RM-100", name: "Футболка белая M", barcode: "4600000000017", got: 20 },
    { article: "RM-101", name: "Футболка чёрная L", barcode: "4600000000024", got: 15 },
    { article: "RM-102", name: "Кружка керамическая", barcode: "4600000000031", got: 8 },
  ] });
  await a("POST", "/api/receive", { client: "ИП Петров", doc: "", cell: "A-01-1-01", lines: [
    { article: "PT-1", name: "Чехол для телефона", barcode: "4600000000048", got: 40 },
  ] });
  console.log("готово");
})().catch(e => { console.error(e.message); process.exit(1); });

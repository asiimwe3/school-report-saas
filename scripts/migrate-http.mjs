/** Runs prisma SQL migration over Neon's HTTPS SQL proxy (port 5432 blocked here). */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL; // pooled Neon URL (HTTPS)
const sql = readFileSync(process.argv[2] ?? "prisma/migrations/0001_init/migration.sql", "utf8");

function splitStatements(text) {
  const stmts = [];
  let cur = "", inS = false, inD = false, dollar = null, i = 0;
  while (i < text.length) {
    const ch = text[i], two = text.slice(i, i + 2);
    if (two === "--") { const e = text.indexOf("\n", i); cur += text.slice(i, e < 0 ? text.length : e); i = e < 0 ? text.length : e; continue; }
    if (two === "/*") { const e = text.indexOf("*/", i) + 2; cur += text.slice(i, e); i = e; continue; }
    if (!inS && !inD && !dollar && two === "$$") { dollar = "$$"; cur += two; i += 2; continue; }
    if (!inS && !inD && !dollar && /^\$[a-zA-Z]+\$/.test(text.slice(i))) {
      const m = text.slice(i).match(/^(\$[a-zA-Z]+\$)/)[0]; dollar = m; cur += m; i += m.length; continue;
    }
    if (dollar && text.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; }
    if (ch === "'" && !inD && !dollar) { inS = !inS; cur += ch; i++; continue; }
    if (ch === '"' && !inS && !dollar) { inD = !inD; cur += ch; i++; continue; }
    if (ch === ";" && !inS && !inD && !dollar) { stmts.push(cur.trim()); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts.filter(Boolean);
}

const stmts = splitStatements(sql);
console.log(`Executing ${stmts.length} statements over HTTPS…`);
const q = neon(url);
let n = 0;
for (const s of stmts) {
  try { await q.query(s); n++; }
  catch (e) {
    if (!/already exists/i.test(String(e))) { console.error(`FAILED after ${n}:\n${s.slice(0, 200)}\n${e}`); process.exit(1); }
  }
}
console.log(`Done: ${n}/${stmts.length} statements applied.`);

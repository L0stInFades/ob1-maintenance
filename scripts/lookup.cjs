#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const query = process.argv[2];
if (!query) { console.error("Usage: node scripts/lookup.cjs <export name, minified symbol, or method>"); process.exit(1); }
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, "reports", name + ".json"), "utf8"));
const symbols = read("symbols"), aliases = read("export-aliases"), classes = read("classes");
const matches = (name) => typeof name === "string" && name.toLowerCase().includes(query.toLowerCase());
for (const a of aliases.filter((a) => matches(a.exportedName) || a.symbol === query)) {
  const s = symbols.find((s) => s.name === a.symbol);
  console.log(`${a.exportedName} -> ${a.symbol}    src/ob1.cjs:${s?.line ?? a.line}`);
}
for (const s of symbols.filter((s) => s.name === query)) console.log(`${s.kind} ${s.name}    src/ob1.cjs:${s.line}`);
for (const c of classes) {
  if (c.name === query) console.log(`class ${c.name}    src/ob1.cjs:${c.line}`);
  for (const m of c.methods.filter((m) => matches(m.name))) console.log(`${c.name ?? "<anonymous>"}.${m.name}    src/ob1.cjs:${m.line}`);
}
